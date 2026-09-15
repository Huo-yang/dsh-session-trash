/**
 * 回收站索引：`$DSH_HOME/storages/dsh_session_trash.json`。
 *
 * 文件同时保存两件事：
 * - `policy` —— 删除策略（设置页写入，热生效）。
 * - `sessions` —— 已删除会话条目，按删除时间倒序。
 *
 * 删除采用「索引软删除」：会话日志留在原位、条目只进入索引，所以删除过程中
 * 不会碰到正在写入的会话文件；只有彻底删除（手工或到期清理）才真正删除
 * `sessions/` 下的会话目录。正常恢复仅移除索引；完整暂存目录需先搬回原位。
 *
 * 写操作用一个队列串行化：并发的面板操作不会互相覆盖。落盘走
 * 「临时文件 + rename」，进程崩溃不会留下半截 JSON。
 */
import { mkdir, readFile, readdir, rename, rm, lstat, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DEFAULT_POLICY, normalizePolicy } from './policy.js'

/** 索引文件格式版本；语义变更时递增，用于识别旧文件并做一次性迁移。 */
const FORMAT_VERSION = 2

/** 会话目录清单的缓存时长：够短，删除后很快能被看到；够长，不会被同步刷爆。 */
const DIR_CACHE_TTL_MS = 1500

/**
 * 创建回收站索引访问器。
 * @param {object} options 依赖与位置。
 * @param {string} options.file 索引文件的绝对路径。
 * @param {string} options.trashRoot 彻底删除时会话目录先移动到的暂存根目录。
 * @param {string} options.sessionsRoot DSH 会话目录根（`$DSH_HOME/sessions`）。
 * @param {() => number} [options.now] 时钟，注入以便测试。
 * @returns {object} 索引访问器。
 */
export function createTrashStore({ file, trashRoot, sessionsRoot, now = () => Date.now() }) {
  /** @type {Promise<unknown>} 串行化所有写操作的队列尾。 */
  let writeQueue = Promise.resolve()

  /** 会话目录名清单的缓存（见 `classifySessionDirs`）：同步是高频的，别每次都读盘。 */
  let dirCache = null

  /**
   * 读盘并规整。文件缺失按空索引处理；文件损坏时先备份再以空索引继续。
   * @returns {Promise<{policy: typeof DEFAULT_POLICY, sessions: object[], lastSweepAt: number|null}>} 完整状态。
   */
  async function load() {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState()
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      // 手工编辑写坏的情况：把原文挪到 .corrupt 再以空索引继续——回收站不应
      // 因为一个坏字符就让整个面板打不开。
      await rename(file, `${file}.corrupt-${String(now())}`).catch(() => {})
      return emptyState()
    }
    return normalizeState(parsed)
  }

  /**
   * 在写队列上执行一次「重读-修改-落盘」。
   * @param {(state: {policy: typeof DEFAULT_POLICY, sessions: object[], lastSweepAt: number|null}) => (unknown | Promise<unknown>)} mutate 修改函数。
   * @returns {Promise<void>} 落盘完成后 resolve。
   */
  function commit(mutate) {
    const run = writeQueue.then(async () => {
      const state = await load()
      await mutate(state)
      await persist(state)
    })
    // 队列本身不能因为一次失败而中断后续写操作。
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 原子落盘。
   * @param {{policy: typeof DEFAULT_POLICY, sessions: object[], lastSweepAt: number|null}} state 待写状态。
   * @returns {Promise<void>} 写完成后 resolve。
   */
  async function persist(state) {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
    const document = {
      formatVersion: FORMAT_VERSION,
      policy: state.policy,
      sessions: state.sessions,
      lastSweepAt: state.lastSweepAt,
    }
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  }

  /**
   * 定位一个会话目录：已知 `cwd` 时直接按 DSH 的目录规则拼路径，否则扫描项目目录层。
   * @param {string} sessionId 会话 id。
   * @param {string|undefined} cwd 会话工作目录。
   * @returns {Promise<{dir: string, sizeBytes: number}|null>} 目录路径与字节数，或 `null`。
   */
  async function findSessionDir(sessionId, cwd) {
    const segment = encodeSegment(sessionId)
    const candidates = []
    if (typeof cwd === 'string' && cwd !== '') {
      candidates.push(`${sessionsRoot}/${projectDirName(cwd)}/${segment}`)
    } else {
      candidates.push(`${sessionsRoot}/_no-cwd/${segment}`)
    }
    for (const candidate of candidates) {
      const size = await directorySize(candidate)
      if (size !== null) return { dir: candidate, sizeBytes: size }
    }
    // cwd 与索引不一致（例如会话被移动过）：扫描项目目录层兜底。
    let projects = []
    try {
      projects = await readdirNames(sessionsRoot)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    for (const project of projects) {
      const dir = `${sessionsRoot}/${project}/${segment}`
      const size = await directorySize(dir)
      if (size !== null) return { dir, sizeBytes: size }
    }
    return null
  }

  /**
   * 批量判断一批会话的日志目录**此刻是否还在磁盘上**。
   *
   * 存在的理由是一个真实的现象：DSH 的会话列表会一直列出一条**日志已经不在磁盘上**
   * 的会话（只要它还挂在某个客户端实例上，Host 就把它留在列表里；DSH 原生删除工作区
   * 只移除登记，不负责删除会话日志）。浏览器侧于是把它渲染成「未分组」里的残留行。
   * 与其猜哪些 id 是幽灵，不如直接问文件系统。
   *
   * 一次 `readdir` 会话根目录 + 每个项目目录一次 `readdir`，比逐个 `findSessionDir`
   * 便宜得多；结果带一个很短的 TTL，因为同步是高频触发的。
   * @param {string[]} sessionIds 待检查的会话 id。
   * @param {boolean} [fresh] 绕过缓存，供第二次确认使用。
   * @returns {Promise<{present: string[], missing: string[]}>} 分类结果。
   */
  async function classifySessionDirs(sessionIds, fresh = false) {
    const wanted = new Set(sessionIds.filter(id => typeof id === 'string' && id !== ''))
    if (wanted.size === 0) return { present: [], missing: [] }
    const now = Date.now()
    if (fresh || dirCache === null || now - dirCache.at > DIR_CACHE_TTL_MS) {
      const names = new Set()
      let projects = []
      try {
        projects = await readdirNames(sessionsRoot)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      for (const project of projects) {
        for (const name of await readdirNames(`${sessionsRoot}/${project}`)) names.add(name)
      }
      dirCache = { at: now, names }
    }
    const present = []
    const missing = []
    for (const id of wanted) {
      if (dirCache.names.has(encodeSegment(id))) present.push(id)
      else missing.push(id)
    }
    return { present, missing }
  }

  /**
   * 彻底删除一个会话的落盘痕迹：先搬到 `trashRoot`，再删除暂存目录。
   *
   * 先搬后删让「删除动作」与「物理删除」分开：搬运用一次 rename，是原子的；
   * 随后的递归删除即使中途失败，残留也落在暂存区而不是会话区。
   * @param {object} entry 回收站条目。
   * @param {() => Promise<void>} saveProgress 持久化目录位置和删除阶段。
   * @returns {Promise<void>} 完成后 resolve。
   */
  async function removeEntryFiles(entry, saveProgress) {
    let legacy = null
    if (typeof entry.trashDir === 'string' && entry.trashDir !== '') {
      legacy = resolve(entry.trashDir)
      if (!isSafeTrashChild(legacy, entry.sessionId)) {
        throw new Error('旧版暂存目录不在插件暂存范围内，已停止删除并保留条目')
      }
    }
    const found = await findSessionDir(entry.sessionId, entry.cwd)
    const staged = resolve(trashRoot, encodeSegment(entry.sessionId))
    if (found !== null) {
      await mkdir(trashRoot, { recursive: true })
      if (await pathExists(staged)) throw new Error('原目录与暂存目录同时存在，已停止删除以避免覆盖数据')
      entry.originalDir = resolve(found.dir)
      // 在 rename 前持久化目标：中断后仍能知道目录应恢复到哪里。
      // 已进入物理删除阶段的重试不能降级为“可以完整恢复”。
      if (entry.deletionPhase !== 'deleting') entry.deletionPhase = 'staged'
      await saveProgress()
      // 搬运失败直接保留原目录，不退回可能部分成功的原地递归删除。
      await rename(found.dir, staged)
    }
    entry.deletionPhase = 'deleting'
    await saveProgress()
    await rm(staged, { recursive: true, force: true })
    dirCache = null
    if (legacy !== null && legacy !== staged) await rm(legacy, { recursive: true, force: true })
  }

  function isSafeTrashChild(target, sessionId) {
    const child = relative(resolve(trashRoot), target)
    return child !== '' && child !== '..' && !child.startsWith('..\\') && !child.startsWith('../')
      && !isAbsolute(child) && basename(target) === encodeSegment(sessionId)
  }

  /** 搬回完整暂存目录；任何不确定状态都保留索引并报错。 */
  async function restoreEntryFiles(entry) {
    if (entry.deletionPhase === 'deleting') {
      throw new Error('会话已开始物理删除，无法保证完整恢复；条目已保留，请重试彻底删除')
    }
    const staged = resolve(trashRoot, encodeSegment(entry.sessionId))
    if (await pathExists(staged)) {
      if (entry.deletionPhase !== 'staged' || !entry.originalDir) {
        throw new Error('暂存目录缺少可靠的恢复记录，无法自动恢复；条目已保留')
      }
      const target = resolve(entry.originalDir)
      const child = relative(resolve(sessionsRoot), target)
      if (!child || child === '..' || child.startsWith('..\\') || child.startsWith('../') || isAbsolute(child)
        || basename(target) !== encodeSegment(entry.sessionId)) {
        throw new Error('恢复目标不在会话目录范围内，已停止恢复')
      }
      if (await pathExists(target)) throw new Error('原会话路径已存在，恢复不会覆盖现有数据；条目已保留')
      await mkdir(dirname(target), { recursive: true })
      await rename(staged, target)
      dirCache = null
      return
    }
    if (entry.trashDir && await pathExists(entry.trashDir)) {
      throw new Error('发现旧版本暂存目录，无法确认数据完整性；条目已保留')
    }
    if (await findSessionDir(entry.sessionId, entry.cwd) === null) {
      throw new Error('会话日志不存在，无法恢复；条目已保留')
    }
  }

  return {
    /** 索引文件绝对路径。 */
    file,
    /** 彻底删除前的暂存根目录。 */
    trashRoot,
    /** 会话目录根。 */
    sessionsRoot,
    load,
    findSessionDir,
    classifySessionDirs,

    /**
     * 读取当前策略。
     * @returns {Promise<typeof DEFAULT_POLICY>} 策略。
     */
    async readPolicy() {
      return (await load()).policy
    },

    /**
     * 合并并保存策略。
     * @param {unknown} patch 部分策略字段。
     * @returns {Promise<typeof DEFAULT_POLICY>} 保存后的完整策略。
     */
    async updatePolicy(patch) {
      let next
      await commit(current => {
        next = normalizePolicy({ ...current.policy, ...(patch ?? {}) })
        current.policy = next
      })
      return next
    },

    /**
     * 列出回收站条目（删除时间倒序），附带到期时间与目录是否还在。
     * @returns {Promise<object[]>} 条目列表。
     */
    async list() {
      const state = await load()
      const policy = state.policy
      const entries = [...state.sessions].sort((left, right) => right.deletedAt - left.deletedAt)
      /** @type {object[]} */
      const rows = []
      for (const entry of entries) {
        const found = await findSessionDir(entry.sessionId, entry.cwd)
        rows.push({
          ...entry,
          keepDays: typeof entry.keepDays === 'number' ? entry.keepDays : policy.keepDays,
          expiresAt: expiryOf(entry, policy),
          sizeBytes: found === null ? 0 : found.sizeBytes,
          filesPresent: found !== null,
        })
      }
      return rows
    },

    /**
     * 记录删除（软删除）。会话日志保持原位，恢复只需删除索引条目。
     * @param {object[]} inputs 待删除会话，每项含 `sessionId` 与可选元数据。
     * @returns {Promise<{added: object[]}>} 新增或刷新的条目。
     */
    async add(inputs) {
      /** @type {object[]} */
      const added = []
      await commit(current => {
        addEntries(current, inputs, added)
      })
      return { added }
    },

    /** 将登记与物理删除放在同一个队列槽内，恢复请求不能插入两步之间。 */
    async addAndPurge(inputs, onRemoved = async () => {}) {
      const result = { purged: [], failed: [] }
      await commit(async current => {
        addEntries(current, inputs)
        const wanted = new Set(inputs.map(input => String(input.sessionId)))
        await removeEntries(current, entry => wanted.has(entry.sessionId), onRemoved, result)
      })
      return result
    },

    /**
     * 从回收站恢复：确认日志在原位或搬回完整暂存目录后，再移除索引。
     * @param {string} sessionId 会话 id。
     * @returns {Promise<{restored: boolean, reason?: string}>} 恢复结果。
     */
    async restore(sessionId) {
      let restored = false
      /** @type {string|undefined} */
      let reason
      await commit(async current => {
        const index = current.sessions.findIndex(entry => entry.sessionId === sessionId)
        if (index < 0) {
          reason = 'not-in-trash'
          return
        }
        await restoreEntryFiles(current.sessions[index])
        current.sessions.splice(index, 1)
        restored = true
      })
      return reason === undefined ? { restored } : { restored, reason }
    },

    /**
     * 彻底删除一个条目：删除会话目录并移除索引条目。
     * @param {string} sessionId 会话 id。
     * @param {(sessionId: string) => Promise<void>} [onRemoved] 文件删除成功后的关联清理。
     * @returns {Promise<{purged: boolean, reason?: string}>} 删除结果。
     */
    async purge(sessionId, onRemoved = async () => {}) {
      const result = await removeMatching(entry => entry.sessionId === sessionId, onRemoved)
      if (result.failed.length) throw new Error(result.failed[0].message)
      return result.purged.length ? { purged: true } : { purged: false, reason: 'not-in-trash' }
    },

    /** 清空时逐条报告成功与失败，失败条目保留以便重试。 */
    async empty(onRemoved = async () => {}) {
      const result = await removeMatching(() => true, onRemoved)
      return { purged: result.purged.length, purgedSessionIds: result.purged, failed: result.failed }
    },

    /** 自动与手动清点使用同一删除流程。 */
    async sweep(force = false, onRemoved = async () => {}) {
      const timestamp = now()
      return removeMatching((entry, state) => {
        const expiry = expiryOf(entry, state.policy)
        return (force || state.policy.autoPurge) && expiry !== null && expiry <= timestamp
      }, onRemoved, timestamp)
    },
  }

  /** 文件删除、关联清理、索引更新在同一写队列内；批量失败互不影响。 */
  async function removeMatching(matches, onRemoved, sweepAt) {
    const result = { purged: [], failed: [], checked: 0 }
    await commit(async current => {
      result.checked = current.sessions.length
      await removeEntries(current, matches, onRemoved, result)
      if (sweepAt !== undefined) current.lastSweepAt = sweepAt
    })
    return result
  }

  async function removeEntries(current, matches, onRemoved, result) {
    for (const entry of [...current.sessions]) {
      if (!matches(entry, current)) continue
      try {
        await removeEntryFiles(entry, () => persist(current))
        await onRemoved(entry.sessionId)
      } catch (error) {
        result.failed.push({ sessionId: entry.sessionId, message: error instanceof Error ? error.message : String(error) })
        continue
      }
      current.sessions = current.sessions.filter(item => item.sessionId !== entry.sessionId)
      await persist(current)
      result.purged.push(entry.sessionId)
    }
  }

  function addEntries(current, inputs, added = []) {
    for (const input of inputs) {
      const sessionId = String(input.sessionId)
      const existing = current.sessions.find(entry => entry.sessionId === sessionId)
      if (existing !== undefined) {
        existing.deletedAt = now()
        existing.keepDays = current.policy.keepDays
        applyMetadata(existing, input)
        added.push(existing)
        continue
      }
      const entry = {
        sessionId, title: '', workspace: '', cwd: '', createdAt: null,
        deletedAt: now(), keepDays: current.policy.keepDays,
        originalDir: '', trashDir: '', sizeBytes: 0, stale: true,
      }
      applyMetadata(entry, input)
      current.sessions.push(entry)
      added.push(entry)
    }
  }

  /**
   * 把请求里的元数据合并进条目（只覆盖非空字段）。
   * @param {object} entry 目标条目。
   * @param {object} input 请求负载。
   * @returns {void}
   */
  function applyMetadata(entry, input) {
    if (typeof input.title === 'string' && input.title !== '') entry.title = input.title
    if (typeof input.workspace === 'string' && input.workspace !== '') entry.workspace = input.workspace
    if (typeof input.cwd === 'string' && input.cwd !== '') entry.cwd = input.cwd
    if (typeof input.createdAt === 'number') entry.createdAt = input.createdAt
  }

  /** @returns {{policy: typeof DEFAULT_POLICY, sessions: object[], lastSweepAt: number|null}} 空状态。 */
  function emptyState() {
    return { policy: { ...DEFAULT_POLICY }, sessions: [], lastSweepAt: null }
  }
}

/**
 * 条目到期时间：`deletedAt + keepDays`；永久保留（`keepDays === 0`）返回 `null`。
 * @param {object} entry 回收站条目。
 * @param {typeof DEFAULT_POLICY} policy 当前策略。
 * @returns {number|null} 到期毫秒时间戳。
 */
export function expiryOf(entry, policy) {
  const keepDays = typeof entry.keepDays === 'number' ? entry.keepDays : policy.keepDays
  if (keepDays <= 0) return null
  return (typeof entry.deletedAt === 'number' ? entry.deletedAt : 0) + keepDays * 86_400_000
}

/**
 * 会话项目目录名。
 *
 * 与 DSH `@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey` 逐字符
 * 等价：`/`、`\`、`:` 折叠成单个 `-`；`~` 与非 `[A-Za-z0-9._-]` 字符写成
 * `~XXXX`（码元十六进制，大写补零）；去掉前导 `-`（全被折叠时用 `root`），
 * 截断到 251 字符后包上 `--…--`。
 * @param {string} cwd 会话工作目录。
 * @returns {string} 项目目录名。
 */
export function projectDirName(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * 会话目录段名，与 DSH 的 `encodeSegment` 等价。
 * @param {string} raw 会话 id。
 * @returns {string} 文件系统安全的单段名。
 */
export function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) out += character
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * 规整读到的索引文档。
 *
 * 旧格式（`formatVersion < 2`）的默认策略把「移入回收站前确认」也设为开启。该
 * 动作可恢复，新版默认不再打扰；但策略是持久化字段，旧文件会一直保留
 * `confirmDelete: true`，让新默认永远不生效。因此升级旧文件时把它迁移到新默认。
 * @param {unknown} parsed 已解析的 JSON。
 * @returns {{policy: typeof DEFAULT_POLICY, sessions: object[], lastSweepAt: number|null}} 规整状态。
 */
function normalizeState(parsed) {
  const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const policy = normalizePolicy(source['policy'])
  const formatVersion = typeof source['formatVersion'] === 'number' ? source['formatVersion'] : 1
  if (formatVersion < 2 && policy.confirmDelete === true) policy.confirmDelete = false
  const rawSessions = Array.isArray(source['sessions']) ? source['sessions'] : []
  const sessions = []
  for (const raw of rawSessions) {
    if (raw === null || typeof raw !== 'object') continue
    const sessionId = raw['sessionId']
    if (typeof sessionId !== 'string' || sessionId === '') continue
    sessions.push({
      sessionId,
      title: typeof raw['title'] === 'string' ? raw['title'] : '',
      workspace: typeof raw['workspace'] === 'string' ? raw['workspace'] : '',
      cwd: typeof raw['cwd'] === 'string' ? raw['cwd'] : '',
      createdAt: typeof raw['createdAt'] === 'number' ? raw['createdAt'] : null,
      deletedAt: typeof raw['deletedAt'] === 'number' ? raw['deletedAt'] : 0,
      keepDays: typeof raw['keepDays'] === 'number' ? raw['keepDays'] : null,
      originalDir: typeof raw['originalDir'] === 'string' ? raw['originalDir'] : '',
      trashDir: typeof raw['trashDir'] === 'string' ? raw['trashDir'] : '',
      deletionPhase: raw['deletionPhase'] === 'staged' || raw['deletionPhase'] === 'deleting' ? raw['deletionPhase'] : null,
      sizeBytes: typeof raw['sizeBytes'] === 'number' ? raw['sizeBytes'] : 0,
      stale: raw['stale'] === true,
    })
  }
  return {
    policy,
    sessions,
    lastSweepAt: typeof source['lastSweepAt'] === 'number' ? source['lastSweepAt'] : null,
  }
}

/**
 * 列目录项名称；读取失败由调用方区分不存在与其它错误。
 * @param {string} dir 目录路径。
 * @returns {Promise<string[]>} 目录项名称。
 */
async function readdirNames(dir) {
  return readdir(dir)
}

/**
 * 计算目录总字节数；目录不存在时返回 `null`。
 * @param {string} dir 目录路径。
 * @returns {Promise<number|null>} 字节数。
 */
async function directorySize(dir) {
  let files = []
  try {
    files = await readdirNames(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let total = 0
  for (const name of files) {
    try {
      total += (await stat(`${dir}/${name}`)).size
    } catch {
      // 单个文件读不到不影响会话目录的整体统计。
    }
  }
  return total
}

/** lstat 也识别符号链接占位，不能把已有路径当作可覆盖的空位。 */
async function pathExists(path) {
  try { await lstat(path); return true }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}
