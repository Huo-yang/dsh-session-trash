/**
 * dsh-session-trash 的 Host 半边。
 *
 * 职责：
 * 1. 组装回收站索引与删除策略的持久化位置（`$DSH_HOME/storages/dsh_session_trash.json`）。
 * 2. 在 `ctx.webServer` 上注册 `/session-trash` 路由，供浏览器半边读写。
 * 3. 按策略定时清点到期的回收站条目。
 *
 * 本插件只依赖 `ctx.webServer` 这一个服务：没有 Web 服务的 profile（headless、
 * TUI）会静默跳过路由注册，不会影响启动。
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_KEEP_DAYS } from './policy.js'
import { createTrashStore } from './store.js'
import { TrashRequestError, registerTrashRoutes } from './routes.js'
import { installRuntimeReleaseGuard } from './runtime.js'

/** 到期清点的间隔；条目粒度是天，半小时一次足以让删除按保留期发生。 */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文。
 * @returns {void}
 */
export function apply(ctx) {
  const storagesDir = dshHomePath('storages')
  const sessionsRoot = dshHomePath('sessions')
  const store = createTrashStore({
    file: `${storagesDir}/dsh_session_trash.json`,
    trashRoot: `${storagesDir}/dsh_session_trash_files`,
    sessionsRoot,
  })
  const runtime = installRuntimeReleaseGuard(ctx)
  // 工作区注册表：彻底删除时要同时把会话从工作区条目里摘掉。用 `ctx.inject`
  // 等待它出现（没有工作区注册表的 profile 会一直等不到，因此只在拿到时才用）。
  /** @type {any} */
  let workspaceRegistry
  ctx.inject(['workspaceRegistry'], scope => {
    workspaceRegistry = scope.workspaceRegistry
  })
  const handlers = createHandlers(ctx, store, () => workspaceRegistry, runtime)

  // 路由必须等到 `webServer` 真的被提供之后再注册：插件行的激活顺序与
  // webserver 行无关，`ctx.get('webServer')` 在启动早期会是 undefined。
  // `ctx.inject` 注册的是一个依赖 fiber，服务出现时装载、消失时自动卸载。
  ctx.inject(['webServer'], scope => {
    scope.effect(
      () => registerTrashRoutes({ webServer: scope.webServer, handlers }),
      'session-trash: routes',
    )
  })

  // 启动时先清点一次（把上次运行期间到期的条目清掉），随后按固定间隔继续。
  // 清点是后台维护：没有 Web 服务的 profile 也照样清理自己的索引文件。
  const timer = setInterval(() => {
    void sweepQuietly(ctx, store, () => workspaceRegistry, runtime)
  }, SWEEP_INTERVAL_MS)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'session-trash: sweep timer')
  queueMicrotask(() => {
    void sweepQuietly(ctx, store, () => workspaceRegistry, runtime)
  })
}

/**
 * 执行一次到期清点，失败只记日志（清点是后台维护，不应打断任何请求路径）。
 * @param {any} ctx Cordis 上下文。
 * @param {ReturnType<typeof createTrashStore>} store 回收站索引。
 * @param {() => any} getWorkspaceRegistry 取当前工作区注册表。
 * @returns {Promise<void>} 完成后 resolve。
 */
export async function sweepQuietly(ctx, store, getWorkspaceRegistry, runtime = { acquire: async () => () => {} }) {
  try {
    const { purged, failed } = await store.sweep(false, removalHooks(ctx, getWorkspaceRegistry, runtime))
    for (const failure of failed) ctx.logger('session-trash').warn(`清理失败 ${failure.sessionId}: ${failure.message}`)
    if (purged.length > 0) {
      ctx.logger('session-trash').info(`到期清理：彻底删除 ${String(purged.length)} 个会话`)
    }
  } catch (error) {
    ctx.logger('session-trash').warn(error)
  }
}

/**
 * 把会话从**所有**工作区的条目里摘掉。
 *
 * 软删除只在客户端把行藏起来，`workspace.sessionIds` 里仍然留着它；一旦会话被
 * 彻底删除（日志已不在），那条目就成了永远点不开的悬挂引用——用户看到的就是
 * 「彻底删除了，工作区里还挂着一条」。这里用 `Workspace.detachSession` 这个
 * 公开方法把它摘掉，注册表会自己广播变化，界面随之更新。
 *
 * 尽力而为：工作区注册表缺席（没有工作区服务的 profile）或某次摘除失败都不应
 * 让「删除会话」失败——日志该删还是要删，只是条目留着。
 * @param {any} ctx Cordis 上下文（仅用于记日志）。
 * @param {any} registry 工作区注册表，可能尚未就绪。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<void>} 完成后 resolve。
 */
async function detachFromWorkspaces(ctx, registry, sessionId) {
  if (registry === undefined || registry === null) return
  let workspaces = []
  try {
    workspaces = registry.list()
  } catch (error) {
    ctx.logger('session-trash').warn(
      `读取工作区列表失败，跳过条目清理：${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  for (const workspace of workspaces) {
    if (!workspace.sessionIds?.includes(sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      ctx.logger('session-trash').warn(
        `从工作区「${workspace.title}」移除会话 ${sessionId} 失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/** 运行时释放必须先于文件删除；工作区摘除则在文件删除成功后执行。 */
function removalHooks(ctx, getWorkspaceRegistry, runtime) {
  const onRemoved = sessionId => detachFromWorkspaces(ctx, getWorkspaceRegistry(), sessionId)
  onRemoved.beforeRemove = sessionId => runtime.acquire(sessionId)
  onRemoved.onRemoved = onRemoved
  return onRemoved
}

/**
 * 读一个会话头里的 `cwd`。
 * @param {any} persistence 会话持久化服务。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<string|undefined>} `cwd`，读不到时 undefined。
 */
async function readStoredCwd(persistence, sessionId) {
  let snapshots
  try {
    snapshots = await persistence.list()
  } catch {
    return undefined
  }
  const snapshot = snapshots.find(item => item?.header?.id === sessionId)
  const cwd = snapshot?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * 构造全部路由实现。
 * @param {any} ctx Cordis 上下文。
 * @param {ReturnType<typeof createTrashStore>} store 回收站索引。
 * @param {() => any} getWorkspaceRegistry 取当前工作区注册表（可能尚未就绪）。
 * @returns {Record<string, {method: string, run: (payload: any) => Promise<unknown>}>} 端点表。
 */
export function createHandlers(ctx, store, getWorkspaceRegistry, runtime = { acquire: async () => () => {} }) {
  const hooks = removalHooks(ctx, getWorkspaceRegistry, runtime)
  return {
    state: {
      method: 'GET',
      run: async () => {
        const [policy, sessions] = await Promise.all([store.readPolicy(), store.list()])
        return {
          policy,
          sessions,
          deletedSessionIds: sessions.map(entry => entry.sessionId),
          home: dshHomePath(),
          indexPath: store.file,
          maxKeepDays: MAX_KEEP_DAYS,
        }
      },
    },

    delete: {
      method: 'POST',
      run: async payload => {
        const details = readSessionDetails(payload)
        // 请求意图一经确认不再由动态策略升级；旧客户端默认只能软删除。
        const intent = payload?.intent ?? 'trash'
        if (intent !== 'trash' && intent !== 'permanent') {
          throw new TrashRequestError('trash/invalid-intent', '删除意图必须是 trash 或 permanent')
        }
        if (intent === 'permanent') {
          // 仅显式永久删除请求进入落盘删除流程。
          const result = await store.addAndPurge(details, hooks)
          if (result.failed.length) {
            throw new TrashRequestError('trash/delete-failed', result.failed.map(item => item.message).join('；'))
          }
          return { mode: 'permanent', removed: result.purged }
        }
        const { added } = await store.add(details)
        return { mode: 'trashed', added }
      },
    },

    restore: {
      method: 'POST',
      run: async payload => {
        const sessionId = readSingleSessionId(payload)
        const result = await store.restore(sessionId)
        if (!result.restored) throw new TrashRequestError('trash/not-in-trash', `会话 ${sessionId} 不在回收站中`)
        return { sessionId }
      },
    },

    purge: {
      method: 'POST',
      run: async payload => {
        const sessionId = readSingleSessionId(payload)
        // 仅在条目存在且文件删除成功后清理工作区关联。
        const result = await store.purge(sessionId, hooks)
        if (!result.purged) throw new TrashRequestError('trash/not-in-trash', `会话 ${sessionId} 不在回收站中`)
        return { sessionId }
      },
    },

    empty: {
      method: 'POST',
      run: async () => {
        return store.empty(hooks)
      },
    },

    sweep: {
      method: 'POST',
      run: async () => store.sweep(true, hooks),
    },

    /**
     * 只把会话从工作区条目里摘掉，**不碰任何日志**。
     *
     * 存在的理由有两个：
     * - `purge` 会在日志删除成功后做这件事；单独暴露它，自动化测试就能在不删除任何
     *   数据的前提下验证「条目真的被摘掉了」——落盘删除在测试里是被拦截的；
     * - 手工清理悬挂引用时（日志已经没了但条目还在）它是一个安全工具。
     */
    detach: {
      method: 'POST',
      run: async payload => {
        const sessionId = readSingleSessionId(payload)
        await detachFromWorkspaces(ctx, getWorkspaceRegistry(), sessionId)
        return { sessionId }
      },
    },

    /**
     * 把会话重新挂回它所属的工作区（`detach` 的逆操作，同样不碰日志）。
     *
     * 归属由会话头里的 `cwd` 决定：注册表按 `cwd` 匹配工作区路径。日志已经不存在
     * 时无法挂回——那时条目本来就不该存在（会话已彻底消失），返回 `matched: 0`。
     */
    reattach: {
      method: 'POST',
      run: async payload => {
        const sessionId = readSingleSessionId(payload)
        const registry = getWorkspaceRegistry()
        if (registry === undefined || registry === null) return { sessionId, matched: 0 }
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) return { sessionId, matched: 0 }
        const meta = await readStoredCwd(persistence, sessionId)
        if (meta === undefined) return { sessionId, matched: 0 }
        const workspace = await registry.resolveByPath(meta)
        if (workspace === undefined) return { sessionId, matched: 0 }
        await workspace.attachSession(sessionId)
        return { sessionId, matched: 1, workspace: workspace.title }
      },
    },

    /**
     * 判断一批会话的日志是否还在磁盘上。**只读，不碰任何数据。**
     *
     * 浏览器半边用它识别「幽灵会话」：DSH 的会话列表会一直列出一条日志已经不在磁盘上
     * 的会话（DSH 原生删除工作区只移除登记，不删除会话日志），界面于是把它渲染成
     * 「未分组」里的残留行。与其在浏览器侧猜哪些 id 是幽灵，不如让 Host 直接看文件系统。
     */
    exists: {
      method: 'POST',
      run: async payload => {
        const raw = payload !== null && typeof payload === 'object' ? payload['sessionIds'] : undefined
        const ids = Array.isArray(raw) ? raw.filter(id => typeof id === 'string' && id !== '') : []
        return store.classifySessionDirs(ids, payload?.fresh === true)
      },
    },

    policy: {
      method: 'POST',
      run: async payload => {
        const patch = payload !== null && typeof payload === 'object' ? payload['policy'] ?? payload : {}
        const policy = await store.updatePolicy(patch)
        return { policy }
      },
    },
  }
}

/**
 * 读取请求里的待删除会话。
 *
 * 浏览器半边持有会话标题、工作区与 `cwd`（都来自它已经渲染的列表），因此删除
 * 请求直接带上这些元数据，回收站列表无需再向会话服务回查——会话被删除后
 * 那些查询本来也未必还能成功。只带 id 的旧式请求同样接受。
 * @param {any} payload 请求体。
 * @returns {{sessionId: string, title: string, workspace: string, cwd: string, createdAt: number|null}[]} 去重后的会话元数据。
 */
function readSessionDetails(payload) {
  const rawList = payload !== null && typeof payload === 'object' ? payload['sessions'] : undefined
  const rawIds = payload !== null && typeof payload === 'object' ? payload['sessionIds'] : undefined
  const candidates = Array.isArray(rawList) ? rawList : Array.isArray(rawIds) ? rawIds : []
  /** @type {Map<string, {sessionId: string, title: string, workspace: string, cwd: string, createdAt: number|null}>} */
  const details = new Map()
  for (const candidate of candidates) {
    const source = typeof candidate === 'string' ? { sessionId: candidate } : candidate
    if (source === null || typeof source !== 'object') continue
    const sessionId = source['sessionId']
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (details.has(sessionId)) continue
    details.set(sessionId, {
      sessionId,
      title: typeof source['title'] === 'string' ? source['title'] : '',
      workspace: typeof source['workspace'] === 'string' ? source['workspace'] : '',
      cwd: typeof source['cwd'] === 'string' ? source['cwd'] : '',
      createdAt: typeof source['createdAt'] === 'number' ? source['createdAt'] : null,
    })
  }
  if (details.size === 0) throw new TrashRequestError('trash/no-session', '请求里没有会话 id')
  return [...details.values()]
}

/**
 * 读取请求里的单个会话 id。
 * @param {any} payload 请求体。
 * @returns {string} 会话 id。
 */
function readSingleSessionId(payload) {
  const value = payload !== null && typeof payload === 'object' ? payload['sessionId'] : undefined
  if (typeof value !== 'string' || value === '') throw new TrashRequestError('trash/no-session', '请求里没有会话 id')
  return value
}
