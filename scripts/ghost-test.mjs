/**
 * 「彻底删除」的真端到端测试：**用一条合成会话**走完真实的删除流程。
 *
 * 为什么需要它：`ui-test.mjs` 在传输层拦掉了落盘删除，所以它只能验证「先摘条目、
 * 后删日志」这类**不删数据**的路径。而用户报的那个现象——「彻底删除之后行跑到未分组
 * 分组里，硬刷新才消失」——只在**真的删掉日志、且这条会话正被打开**时才出现：Host
 * 会把移除推迟，会话留在客户端列表里，于是被渲染成「未分组」。这条链路必须有真实
 * 删除才能覆盖。
 *
 * 安全边界（每一条都必要）：
 *   1. 只创建**自己造的**会话：id 与目录名都由本脚本随机生成，头部写入临时 cwd；
 *   2. 删除前核对目标行的会话 id 等于自己造的 id——不相等就直接放弃，绝不动别的行；
 *   3. 只删自己那条：删除动作通过界面菜单触发，但点击前已经核对过 id；
 *   4. 收尾无论如何都清掉自己造的目录，并把它从工作区/回收站里摘干净；
 *   5. 运行前后打印副作用清单，便于人工核对。
 *
 * 用法：node scripts/ghost-test.mjs --port 3083 --url-token <token>
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { projectDirName } from '../src/host/store.js'

const BROWSER_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = Number(readArg('--port') ?? 3081)
const TOKEN = readArg('--url-token') ?? ''
const DSH_HOME = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
const BASE = `http://127.0.0.1:${String(PORT)}`
/** 合成会话的工作目录：临时目录，因此它不会落到任何真实工作区分组里。 */
const TEST_CWD = join(tmpdir(), `dsh-ghost-${randomUUID().slice(0, 8)}`)
const SESSION_ID = `session-${randomUUID()}`
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

let checks = 0
let failures = 0

/**
 * 取 `--flag value` 形式的参数。
 * @param {string} flag 参数名。
 * @returns {string|undefined} 参数值。
 */
function readArg(flag) {
  const index = process.argv.indexOf(flag)
  return index < 0 ? undefined : process.argv[index + 1]
}

/**
 * 断言并打印。
 * @param {boolean} condition 条件。
 * @param {string} message 说明。
 * @returns {void}
 */
function check(condition, message) {
  checks += 1
  if (condition) console.log(`  PASS  ${message}`)
  else {
    failures += 1
    console.log(`  FAIL  ${message}`)
  }
}

/**
 * 把一个 session.v3 日志文件切成 zstd 帧（每行一帧）。
 * @param {string} file 文件路径。
 * @returns {Buffer[]} 各帧原始字节。
 */
function readFrames(file) {
  const buffer = readFileSync(file)
  const offsets = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i)
  }
  return offsets.map((offset, index) => buffer.subarray(offset, index + 1 < offsets.length ? offsets[index + 1] : buffer.length))
}

/**
 * 找一条**非空**的真实会话当日志模板。
 *
 * 空日志会被 DSH 当成 blank 而不在侧边栏显示（`sessionVisible` 里明写着
 * `!session.blank || session.id === current`），所以复制的事件帧必须包含**真正的
 * 内容事件**（`assistant/message` 之类），只有 `permission/preset`、`step/start`
 * 这类元数据的会话仍然是 blank。事件格式随版本变化，凭空构造容易漂移，直接从一条
 * 真实会话里复制到第一条内容消息为止最稳。
 * @returns {Buffer[]} 事件帧（不含头部）。
 */
function readDonorFrames() {
  const root = join(DSH_HOME, 'sessions')
  for (const project of readdirSync(root)) {
    for (const session of readdirSync(join(root, project))) {
      const file = join(root, project, session, 'session.v3.jsonl.zstd')
      if (!existsSync(file)) continue
      const frames = readFrames(file)
      const events = []
      for (const frame of frames.slice(1, 24)) {
        events.push(frame)
        const type = readEventType(frame)
        if (type === 'assistant/message' || type === 'user/message' || type === 'turn/end') return events
      }
    }
  }
  throw new Error('没找到带内容事件、可用作模板的真实会话日志')
}

/**
 * 读一帧事件的 `type`。
 * @param {Buffer} frame zstd 帧。
 * @returns {string} 事件类型，读不出来时为空串。
 */
function readEventType(frame) {
  try {
    return JSON.parse(zstdDecompressSync(frame).toString('utf8').split('\n')[0]).type ?? ''
  } catch {
    return ''
  }
}

/** 合成会话所在的项目目录（**直接用 Host 的路径规则**，别自己拼）。 */
function projectDirOf(cwd) {
  return join(DSH_HOME, 'sessions', projectDirName(cwd))
}

const SESSION_DIR = join(projectDirOf(TEST_CWD), SESSION_ID)

/**
 * 造一条非空的合成会话。
 * @returns {void}
 */
function createSyntheticSession() {
  mkdirSync(TEST_CWD, { recursive: true })
  mkdirSync(SESSION_DIR, { recursive: true })
  const header = {
    type: 'session', version: 3, id: SESSION_ID, createdAt: Date.now(), cwd: TEST_CWD,
    isSeeded: false, delegationDepth: 0,
  }
  const parts = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')), ...readDonorFrames()]
  writeFileSync(join(SESSION_DIR, 'session.v3.jsonl.zstd'), Buffer.concat(parts))
  const written = readFrames(join(SESSION_DIR, 'session.v3.jsonl.zstd'))
  const first = JSON.parse(zstdDecompressSync(written[0]).toString('utf8').split('\n')[0])
  if (first.id !== SESSION_ID || first.cwd !== TEST_CWD) throw new Error('合成会话头部写错了')
}

/**
 * 调用一个 Host 端点。
 * @param {string} endpoint 端点名。
 * @param {object} body 请求体。
 * @returns {Promise<any>} 响应体。
 */
async function callHost(endpoint, body) {
  const response = await fetch(`${BASE}/session-trash/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return await response.json()
}

/**
 * 读界面现场。
 * @param {import('playwright-core').Page} page 页面。
 * @returns {Promise<object>} 现场。
 */
async function snapshot(page) {
  return await page.evaluate(id => {
    const handle = globalThis.__dshSessionTrash
    const info = handle?.inspect?.()
    const mine = (info?.rows ?? []).find(row => row.identity?.sessionId === id) ?? null
    const ungroupedVisible = [...document.querySelectorAll('[role="treeitem"]')]
      .filter(item => (item.textContent ?? '').trim().startsWith('未分组'))
      .filter(item => getComputedStyle(item).display !== 'none')
    return {
      rowDisplay: mine?.display ?? null,
      ungroupedVisible: ungroupedVisible.length,
      listHasMine: (handle?.sessionListState?.().ids ?? []).includes(id),
      missingMine: (info?.missing ?? []).includes(id),
      purgedMine: (info?.purged ?? []).includes(id),
      visibleRows: (info?.rows ?? []).filter(row => row.display !== 'none').length,
    }
  }, SESSION_ID)
}

/**
 * 在页面里找到自己那条会话的行元素。
 * @param {import('playwright-core').Page} page 页面。
 * @returns {Promise<import('playwright-core').ElementHandle|null>} 行句柄。
 */
async function findOwnRow(page) {
  const handle = await page.evaluateHandle(id => {
    for (const candidate of document.querySelectorAll('[role="treeitem"]')) {
      if (![...candidate.classList].some(name => name.endsWith('sessionRow'))) continue
      const key = Object.keys(candidate).find(name => name.startsWith('__reactFiber$'))
      let fiber = key === undefined ? null : candidate[key]
      for (let depth = 0; depth < 24 && fiber !== null; depth += 1) {
        if (fiber.memoizedProps?.node?.id === id) return candidate
        fiber = fiber.return
      }
    }
    return null
  }, SESSION_ID)
  return handle.asElement()
}

/**
 * 清理合成会话的一切痕迹。
 * @returns {Promise<void>} 完成后 resolve。
 */
async function cleanup() {
  // 先摘工作区条目（万一还挂着），再删目录。
  await callHost('detach', { sessionId: SESSION_ID }).catch(() => {})
  const state = await fetch(`${BASE}/session-trash/state`).then(response => response.json()).catch(() => null)
  if (state?.value?.sessions?.some(item => item.sessionId === SESSION_ID)) {
    await callHost('purge', { sessionId: SESSION_ID }).catch(() => {})
  }
  rmSync(SESSION_DIR, { recursive: true, force: true })
  rmSync(TEST_CWD, { recursive: true, force: true })
  rmSync(projectDirOf(TEST_CWD), { recursive: true, force: true })
}

console.log('== 0. 造一条合成会话（只动自己造的目录） ==')
createSyntheticSession()
console.log(`  ${SESSION_ID}`)
console.log(`  ${SESSION_DIR}`)
check(existsSync(SESSION_DIR), '合成会话已写入磁盘')
// 推 Host 一把去认这条新会话。合成会话的 cwd 在临时目录里，匹配不到任何工作区
// （`matched: 0` 是预期的），但这次调用会走 Host 的会话持久化列举，让它把新目录
// 纳入会话列表——否则一个在服务启动之后才出现的目录不会被列出来。
const nudge = await callHost('reattach', { sessionId: SESSION_ID })
console.log(`  让 Host 认这条会话：matched=${String(nudge.value?.matched ?? '?')}（临时 cwd 匹配不到工作区是正常的）`)

const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
  console.log('== 1. 打开界面，确认能看到这条会话 ==')
  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[role="treeitem"]', { timeout: 60000 })
  await page.waitForTimeout(4000)
  let ownRow = await findOwnRow(page)
  if (ownRow === null) {
    // 合成会话的 cwd 在临时目录里，不属于任何工作区，因此落在「未分组」分组下；
    // 而这个分组默认是**折叠**的（子行根本不渲染）。展开它才能拿到行。
    const ungrouped = page.locator('[role="treeitem"]').filter({ hasText: '未分组' }).first()
    if (await ungrouped.count() > 0) {
      await ungrouped.click()
      await page.waitForTimeout(1500)
      ownRow = await findOwnRow(page)
    }
  }
  check(ownRow !== null, '合成会话出现在侧边栏里（未分组分组下）')
  if (ownRow === null) {
    // 失败时把证据打全：客户端列表里有没有它、Host 认为它在不在磁盘上。
    const evidence = await page.evaluate(id => ({
      ids: (globalThis.__dshSessionTrash?.sessionListState?.().ids ?? []).map(value => String(value).slice(8, 14)),
      has: (globalThis.__dshSessionTrash?.sessionListState?.().ids ?? []).includes(id),
      rows: (globalThis.__dshSessionTrash?.inspect?.().rows ?? []).map(row => `${String(row.identity?.sessionId ?? '?').slice(8, 14)}=${row.display}`),
    }), SESSION_ID)
    const probe = await callHost('exists', { sessionIds: [SESSION_ID] })
    const summary = await page.evaluate(id => globalThis.__dshSessionTrash?.sessionSummary?.(id) ?? null, SESSION_ID)
    console.log(`  证据：客户端列表=${evidence.ids.join(',')} 含它=${String(evidence.has)}`)
    console.log(`       渲染行=${evidence.rows.join(',')}`)
    console.log(`       Host 探测=${JSON.stringify(probe.value)}`)
    console.log(`       会话摘要=${JSON.stringify(summary)?.slice(0, 500)}`)
    throw new Error('合成会话没出现在侧边栏，测试无法继续')
  }
  await ownRow.click()
  await page.waitForTimeout(3000)
  const opened = await page.evaluate(id => globalThis.__dshSessionTrash.sessionListState()?.current === id, SESSION_ID)
  check(opened, '合成会话已经被打开（这正是幽灵现象出现的条件）')

  console.log('== 2. 通过行菜单「彻底删除」它 ==')
  const before = await snapshot(page)
  check(before.rowDisplay !== 'none', '删除前该行可见')
  await ownRow.hover()
  await ownRow.$eval('button[aria-label]', button => { button.click() })
  await page.waitForSelector('div[role="menu"]', { timeout: 10000 })
  await page.locator('div[role="menu"] button[role="menuitem"]').filter({ hasText: '彻底删除' }).first().click()
  await page.waitForSelector('.dst-dialog', { timeout: 10000 })
  const dialogText = (await page.locator('.dst-dialog').first().textContent()) ?? ''
  check(dialogText.includes('彻底删除会话'), '弹出的是「彻底删除」确认框')
  await page.locator('.dst-dialog-actions .dst-button').filter({ hasText: '彻底删除' }).first().click()

  console.log('== 3. 删除之后：行与「未分组」都必须消失（不能等刷新） ==')
  // 采样 12 秒：既要确认「最终」是对的，也要确认中间没有长时间挂着未分组分组。
  let sawVisibleRow = false
  let sawUngrouped = false
  let settled = null
  for (let tick = 0; tick < 24; tick += 1) {
    await page.waitForTimeout(500)
    const state = await snapshot(page)
    if (state.rowDisplay === 'flex') sawVisibleRow = true
    if (state.ungroupedVisible > 0) sawUngrouped = true
    if (state.rowDisplay === null || state.rowDisplay === 'none') settled = state
  }
  const final = await snapshot(page)
  check(!existsSync(SESSION_DIR), '会话日志目录已从磁盘删除')
  check(final.rowDisplay === null || final.rowDisplay === 'none', `该行在界面上不可见（display=${String(final.rowDisplay)}）`)
  check(!sawVisibleRow, '删除后该行从未重新变得可见')
  check(final.ungroupedVisible === 0, `没有可见的「未分组」分组（可见 ${String(final.ungroupedVisible)} 个）`)
  check(!sawUngrouped, '整个观察窗口内都没有出现可见的「未分组」分组')
  check(final.visibleRows >= 1, `界面上仍有其它可见会话（${String(final.visibleRows)} 条）`)
  check(
    (await fetch(`${BASE}/session-trash/state`).then(response => response.json())).value.sessions
      .every(item => item.sessionId !== SESSION_ID),
    '回收站里没有留下这条合成会话',
  )
  console.log(`  现场：${JSON.stringify(settled ?? final)}`)
} finally {
  await browser.close()
  await cleanup()
}

console.log('== 4. 收尾 ==')
check(!existsSync(SESSION_DIR), '合成会话目录已清理')
check(!existsSync(TEST_CWD), '临时工作目录已清理')
const leftover = await fetch(`${BASE}/session-trash/state`).then(response => response.json())
check(
  leftover.value.sessions.every(item => item.sessionId !== SESSION_ID),
  `回收站里没有合成会话（当前 ${String(leftover.value.sessions.length)} 条）`,
)

console.log('')
console.log(`共 ${String(checks)} 项断言，失败 ${String(failures)} 项。`)
// fetch 的 keep-alive 连接会让进程在退出时带着未关闭的套接字触发 libuv 断言
// （Windows 上表现为一个莫名其妙的中止），先销毁连接池再退出。
try {
  const { getGlobalDispatcher } = await import('node:undici').catch(() => ({}))
  await getGlobalDispatcher?.()?.close?.()
} catch {
  /* undici 不可用时忽略：没有连接池需要关闭 */
}
process.exit(failures === 0 ? 0 : 1)
