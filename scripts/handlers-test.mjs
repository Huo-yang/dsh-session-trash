/**
 * Host 端点的行为测试：用假 store / 假工作区注册表把 `createHandlers` 单独跑起来。
 *
 * 存在的理由：`purge`（彻底删除）必须在删日志**之后**把会话从工作区条目里摘掉，
 * 否则界面上会留下一条永远点不开的悬挂引用——这正是用户报过的问题。这条链路的
 * 端到端验证有天然障碍：删除会真的落盘，而合成会话从来不在任何工作区里，靠 HTTP
 * 断言只能得到「本来就是 0」的空结论。所以这里直接对处理器本身下断言：
 * 用事件顺序记录证明「先删日志、后摘条目」，全程不碰任何真实数据。
 *
 * 用法：node scripts/handlers-test.mjs
 */
import { createHandlers } from '../src/host/index.js'

let checks = 0
let failures = 0

/**
 * 断言并打印结果。
 * @param {boolean} condition 断言条件。
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

/** 记录「谁在什么时候做了什么」，用来证明调用顺序。 */
let timeline = []

/**
 * 造一个工作区替身。
 * @param {string} title 标题（同时当作路径）。
 * @param {string[]} sessionIds 初始会话 id。
 * @param {object} [options] 可选：`failDetach` 让摘除抛错。
 * @returns {any} 假工作区。
 */
function makeWorkspace(title, sessionIds, options = {}) {
  return {
    title,
    path: title,
    sessionIds: [...sessionIds],
    async detachSession(sessionId) {
      timeline.push(`detach:${sessionId}@${title}`)
      if (options.failDetach === true) throw new Error('detach 失败')
      this.sessionIds = this.sessionIds.filter(id => id !== sessionId)
    },
    async attachSession(sessionId) {
      timeline.push(`attach:${sessionId}@${title}`)
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
    },
  }
}

/**
 * 造一个回收站索引替身。
 * @param {{useTrash?: boolean}} [policy] 初始策略。
 * @returns {any} 假 store，带 `purgedIds` / `addedIds` 便于断言。
 */
function makeStore(policy = {}) {
  const state = {
    policy: { useTrash: true, keepDays: 30, autoPurge: false, ...policy },
    /** @type {string[]} */
    purgedIds: [],
    /** @type {string[]} */
    addedIds: [],
    /** @type {string[]} */
    entries: [],
  }
  return {
    file: '/tmp/dsh_session_trash.json',
    state,
    /** 预置一条回收站条目，让 `purge` 走通（不在回收站里的会话会被拒绝）。 */
    seed(sessionId, title = '') {
      state.entries.push({ sessionId, title })
    },
    async readPolicy() {
      return { ...state.policy }
    },
    async updatePolicy(patch) {
      state.policy = { ...state.policy, ...patch }
      return { ...state.policy }
    },
    async list() {
      return state.entries
    },
    async add(details) {
      for (const detail of details) {
        state.addedIds.push(detail.sessionId)
        state.entries.push({ sessionId: detail.sessionId, title: detail.title })
      }
      return { added: details.map(detail => detail.sessionId) }
    },
    async addAndPurge(details, onRemoved) {
      await this.add(details)
      const purged = []
      const failed = []
      for (const detail of details) {
        const result = await this.purge(detail.sessionId, onRemoved)
        if (result.purged) purged.push(detail.sessionId)
        else failed.push({ sessionId: detail.sessionId, message: 'not in trash' })
      }
      return { purged, failed }
    },
    async restore(sessionId) {
      const before = state.entries.length
      state.entries = state.entries.filter(entry => entry.sessionId !== sessionId)
      return { restored: state.entries.length !== before }
    },
    async purge(sessionId, onRemoved) {
      timeline.push(`purge:${sessionId}`)
      const before = state.entries.length
      state.entries = state.entries.filter(entry => entry.sessionId !== sessionId)
      if (state.entries.length === before) return { purged: false }
      state.purgedIds.push(sessionId)
      await onRemoved?.(sessionId)
      return { purged: true }
    },
    async empty(onRemoved) {
      for (const entry of state.entries) {
        timeline.push(`purge:${entry.sessionId}`)
        await onRemoved?.(entry.sessionId)
      }
      const purged = state.entries.length
      state.purgedIds.push(...state.entries.map(entry => entry.sessionId))
      state.entries = []
      return { purged }
    },
    async sweep() {
      return { purged: [] }
    },
  }
}

/**
 * 造一个假 Cordis 上下文。
 * @param {Record<string, any>} services 可被 `ctx.get` 取到的服务。
 * @returns {any} 假上下文。
 */
function makeCtx(services = {}) {
  return {
    logger: () => ({ info() {}, warn() {} }),
    get: name => services[name],
  }
}

/**
 * 造一个假工作区注册表。
 * @param {any[]} workspaces 工作区列表（可直接改）。
 * @returns {any} 假注册表。
 */
function makeRegistry(workspaces) {
  return {
    list: () => workspaces,
    async resolveByPath(path) {
      return workspaces.find(item => item.path === path)
    },
  }
}

/**
 * 造一个假会话持久化服务（只提供 `list`）。
 * @param {Record<string, string>} cwdById 会话 id → cwd。
 * @returns {any} 假持久化服务。
 */
function makePersistence(cwdById) {
  return {
    async list() {
      return Object.entries(cwdById).map(([id, cwd]) => ({ header: { id, cwd } }))
    },
  }
}

const SESSION = 'session-aaaaaaaa-1111-2222-3333-444444444444'

console.log('== 1. 彻底删除：先删日志，再摘工作区条目 ==')
{
  timeline = []
  const workspace = makeWorkspace('alpha', [SESSION, 'session-other'])
  const store = makeStore()
  store.seed(SESSION)
  const handlers = createHandlers(
    makeCtx({ sessionPersistence: makePersistence({}) }),
    store,
    () => makeRegistry([workspace]),
  )
  await handlers.purge.run({ sessionId: SESSION })
  check(timeline.join(' | ') === `purge:${SESSION} | detach:${SESSION}@alpha`,
    `摘除发生在删日志之后（实际顺序：${timeline.join(' → ')}）`)
  check(!workspace.sessionIds.includes(SESSION), '会话已从工作区条目里摘掉')
  check(workspace.sessionIds.includes('session-other'), '同工作区其它会话不受影响')
}

console.log('== 2. 挂在多个工作区时逐个摘除 ==')
{
  timeline = []
  const first = makeWorkspace('alpha', [SESSION])
  const second = makeWorkspace('beta', [SESSION])
  const store = makeStore()
  store.seed(SESSION)
  const handlers = createHandlers(makeCtx({}), store, () => makeRegistry([first, second]))
  await handlers.purge.run({ sessionId: SESSION })
  check(first.sessionIds.length === 0 && second.sessionIds.length === 0, '两个工作区都已摘除')
  check(timeline.filter(item => item.startsWith('detach:')).length === 2, '每个工作区各摘一次')
}

console.log('== 3. 某个工作区摘除失败不影响其余工作区 ==')
{
  const broken = makeWorkspace('broken', [SESSION], { failDetach: true })
  const healthy = makeWorkspace('healthy', [SESSION])
  const store = makeStore()
  store.state.entries.push({ sessionId: SESSION, title: '' })
  const handlers = createHandlers(makeCtx({}), store, () => makeRegistry([broken, healthy]))
  let threw = false
  try {
    await handlers.purge.run({ sessionId: SESSION })
  } catch {
    threw = true
  }
  check(!threw, '摘除失败不会让彻底删除整体失败')
  check(healthy.sessionIds.length === 0, '失败之后仍然继续处理下一个工作区')
  check(store.state.purgedIds.includes(SESSION), '日志该删还是删了')
}

console.log('== 4. 没有工作区注册表时也不报错 ==')
{
  const store = makeStore()
  store.state.entries.push({ sessionId: SESSION, title: '' })
  const handlers = createHandlers(makeCtx({}), store, () => undefined)
  let threw = false
  try {
    await handlers.purge.run({ sessionId: SESSION })
  } catch {
    threw = true
  }
  check(!threw, '注册表缺席时彻底删除照常完成')
  check(store.state.purgedIds.includes(SESSION), '注册表缺席时日志仍被删除')
}

console.log('== 5. 彻底删除不在回收站里的会话：报业务错误 ==')
{
  const handlers = createHandlers(makeCtx({}), makeStore(), () => makeRegistry([]))
  let code = ''
  try {
    await handlers.purge.run({ sessionId: 'session-missing' })
  } catch (error) {
    code = error?.code ?? ''
  }
  check(code === 'trash/not-in-trash', `错误码为 trash/not-in-trash（实际：${code}）`)
}

console.log('== 6. 移入回收站（软删除）不动工作区条目 ==')
{
  const workspace = makeWorkspace('alpha', [SESSION])
  const store = makeStore()
  const handlers = createHandlers(makeCtx({}), store, () => makeRegistry([workspace]))
  const result = await handlers.delete.run({ sessions: [{ sessionId: SESSION, title: '标题' }] })
  check(result.mode === 'trashed', '删除模式为 trashed')
  check(workspace.sessionIds.includes(SESSION), '软删除保留工作区条目（界面靠隐藏集合处理）')
  check(store.state.addedIds.includes(SESSION), '条目写进了回收站')
}

console.log('== 7. 显式永久删除也要摘条目 ==')
{
  timeline = []
  const workspace = makeWorkspace('alpha', [SESSION])
  const store = makeStore({ useTrash: false })
  const handlers = createHandlers(makeCtx({}), store, () => makeRegistry([workspace]))
  const result = await handlers.delete.run({ sessions: [{ sessionId: SESSION, title: '标题' }], intent: 'permanent' })
  check(result.mode === 'permanent', '删除模式为 permanent')
  check(!workspace.sessionIds.includes(SESSION), '工作区条目已摘除')
  check(timeline.join(' | ') === `purge:${SESSION} | detach:${SESSION}@alpha`,
    `同样是先删日志后摘条目（实际：${timeline.join(' → ')}）`)
  check(store.state.entries.length === 0, '回收站里不留条目')
}

console.log('== 8. 清空回收站会摘掉每一条的工作区条目 ==')
{
  const first = makeWorkspace('alpha', [SESSION, 'session-second'])
  const store = makeStore()
  store.state.entries.push(
    { sessionId: SESSION, title: '' },
    { sessionId: 'session-second', title: '' },
  )
  const handlers = createHandlers(makeCtx({}), store, () => makeRegistry([first]))
  const result = await handlers.empty.run({})
  check(result.purged === 2, `清空删除了 2 个条目（实际 ${String(result.purged)}）`)
  check(first.sessionIds.length === 0, '两个会话的工作区条目都已摘除')
}

console.log('== 9. detach：不碰日志、不碰回收站 ==')
{
  const workspace = makeWorkspace('alpha', [SESSION])
  const store = makeStore()
  store.state.entries.push({ sessionId: SESSION, title: '' })
  const handlers = createHandlers(makeCtx({}), store, () => makeRegistry([workspace]))
  await handlers.detach.run({ sessionId: SESSION })
  check(workspace.sessionIds.length === 0, '条目已摘除')
  check(store.state.purgedIds.length === 0, '没有删除任何日志')
  check(store.state.entries.length === 1, '回收站条目原样保留')
}

console.log('== 10. reattach：按会话 cwd 挂回原工作区 ==')
{
  const workspace = makeWorkspace('alpha', [])
  const handlers = createHandlers(
    makeCtx({ sessionPersistence: makePersistence({ [SESSION]: 'alpha' }) }),
    makeStore(),
    () => makeRegistry([workspace]),
  )
  const result = await handlers.reattach.run({ sessionId: SESSION })
  check(result.matched === 1, '按 cwd 匹配到了工作区')
  check(workspace.sessionIds.includes(SESSION), '会话已挂回')
}

console.log('== 11. reattach 的边界：读不到 cwd / 没有匹配工作区 / 服务缺席 ==')
{
  const withPersistence = createHandlers(
    makeCtx({ sessionPersistence: makePersistence({}) }),
    makeStore(),
    () => makeRegistry([makeWorkspace('alpha', [])]),
  )
  check((await withPersistence.reattach.run({ sessionId: SESSION })).matched === 0, '读不到 cwd 时 matched=0')
  const noWorkspace = createHandlers(
    makeCtx({ sessionPersistence: makePersistence({ [SESSION]: 'nowhere' }) }),
    makeStore(),
    () => makeRegistry([makeWorkspace('alpha', [])]),
  )
  check((await noWorkspace.reattach.run({ sessionId: SESSION })).matched === 0, 'cwd 不匹配任何工作区时 matched=0')
  const noService = createHandlers(makeCtx({}), makeStore(), () => makeRegistry([makeWorkspace('alpha', [])]))
  check((await noService.reattach.run({ sessionId: SESSION })).matched === 0, '持久化服务缺席时 matched=0')
}

console.log('== 12. 协议边界：缺 sessionId ==')
{
  const handlers = createHandlers(makeCtx({}), makeStore(), () => makeRegistry([]))
  let code = ''
  try {
    await handlers.detach.run({})
  } catch (error) {
    code = error?.code ?? ''
  }
  check(code === 'trash/no-session', `缺少 id 时报 trash/no-session（实际：${code}）`)
  let deleteCode = ''
  try {
    await handlers.delete.run({ sessions: [] })
  } catch (error) {
    deleteCode = error?.code ?? ''
  }
  check(deleteCode === 'trash/no-session', `空会话列表报 trash/no-session（实际：${deleteCode}）`)
}

console.log('')
console.log(`共 ${String(checks)} 项断言，失败 ${String(failures)} 项。`)
process.exit(failures === 0 ? 0 : 1)
