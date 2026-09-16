// 可控定时器及模拟宿主；不打开真实浏览器、不连接 DSH、不删除会话。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { createGhostProbe } from '../src/client/ghost-probe.js'
import { hasPendingStrikes, listMissingSessions, retainProbeSessions } from '../src/client/ghost-sessions.js'
import { isSessionId, readRowIdentity } from '../src/client/row-identity.js'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

test('会话身份同时接受 DSH 前缀 id 和 ACP 裸 UUID', () => {
  assert.equal(isSessionId('session-42'), true)
  assert.equal(isSessionId('session-35148e3f-1111-4222-8333-444444444444'), true)
  assert.equal(isSessionId('35148e3f-1111-4222-8333-444444444444'), true)
  assert.equal(isSessionId('workspace-alpha'), false)
  assert.equal(isSessionId('35148e3f-1111-2222-3333-444444444444'), false)
})

test('从真实 fiber 路径读出 ACP 裸 UUID 会话', t => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  class FakeElement {}
  globalThis.HTMLElement = FakeElement
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'HTMLElement', saved)
    else delete globalThis.HTMLElement
  })
  const row = new FakeElement()
  row.__reactFiber$test = {
    memoizedProps: { node: { id: '35148e3f-1111-4222-8333-444444444444', title: 'ACP', blank: false } },
    return: null,
  }
  assert.deepEqual(readRowIdentity(row), {
    sessionId: '35148e3f-1111-4222-8333-444444444444',
    title: 'ACP',
    blank: false,
  })
})
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function probeFixture(t, response) {
  retainProbeSessions([])
  let ids = ['session-a']
  let sequence = 0
  const timers = new Map()
  const calls = []
  const errors = []
  let changes = 0
  const controller = createGhostProbe({
    getIds: () => ids,
    probe: async (wanted, fresh) => { calls.push({ wanted, fresh }); return response(wanted) },
    onChanged: () => { changes++ }, onError: error => errors.push(error), now: () => 1000,
    setTimer: (fn, delay) => { timers.set(++sequence, { fn, delay }); return sequence },
    clearTimer: id => timers.delete(id),
  })
  t.after(() => { controller.dispose(); retainProbeSessions([]) })
  return { controller, timers, calls, errors, get changes() { return changes },
    setIds(next) { ids = next },
    async tick() {
      const [key, value] = timers.entries().next().value
      timers.delete(key)
      value.fn()
      await flush()
    },
  }
}

test('两次缺失确认只产生一个复测，确认后停止', async t => {
  const f = probeFixture(t, ids => ({ present: [], missing: ids }))
  await f.controller.run()
  assert.equal(f.timers.size, 1)
  assert.equal([...f.timers.values()][0].delay, 200)
  await Promise.all(Array.from({ length: 20 }, () => f.controller.run()))
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.size, 1)
  await f.tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].fresh, true)
  assert.equal(f.timers.size, 0)
  assert.equal(hasPendingStrikes(), false)
  assert.deepEqual(listMissingSessions(), ['session-a'])
})

for (const ids of [[], ['session-b']]) test('会话退出列表后清理待确认记录：' + ids.length, async t => {
  const f = probeFixture(t, wanted => ({ present: wanted.filter(id => id !== 'session-a'), missing: wanted.filter(id => id === 'session-a') }))
  await f.controller.run()
  f.setIds(ids)
  await f.tick()
  assert.equal(hasPendingStrikes(), false)
  assert.equal(f.timers.size, 0)
  assert.deepEqual(listMissingSessions(), [])
})

test('在途请求折叠，列表变化只补一次并忽略已退出会话结果', async t => {
  const pending = deferred()
  const f = probeFixture(t, () => pending.promise)
  const first = f.controller.run()
  await flush()
  f.setIds(['session-b'])
  const other = Array.from({ length: 20 }, () => f.controller.run(true))
  assert.equal(f.calls.length, 1)
  pending.resolve({ present: [], missing: ['session-a'] })
  await Promise.all([first, ...other])
  assert.equal(hasPendingStrikes(), false)
  assert.equal(f.timers.size, 1)
  await f.tick()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1].wanted, ['session-b'])
  assert.equal(f.timers.size, 0)
})

test('卸载取消重试，并拒绝后续调用', async t => {
  const f = probeFixture(t, ids => ({ present: [], missing: ids }))
  await f.controller.run()
  f.controller.dispose()
  assert.equal(f.timers.size, 0)
  await f.controller.run(true)
  assert.equal(f.calls.length, 1)
})

test('卸载后在途响应不写状态、不调度、不刷新 UI', async t => {
  const pending = deferred()
  const f = probeFixture(t, () => pending.promise)
  const running = f.controller.run()
  await flush()
  f.controller.dispose()
  pending.resolve({ present: [], missing: ['session-a'] })
  await running
  assert.equal(hasPendingStrikes(), false)
  assert.equal(f.changes, 0)
  assert.equal(f.timers.size, 0)
})

test('请求失败不进入快速重试循环', async t => {
  const f = probeFixture(t, () => { throw new Error('offline') })
  await f.controller.run()
  assert.equal(f.errors.length, 1)
  assert.equal(f.timers.size, 0)
})

// 运行实际 index.js 的菜单回调；仅替换 DOM/UI 和网络依赖。
const stubs = {
  'api.js': `export async function readState() { return { policy: globalThis.__trashTest.policy, sessions: [] } }
    export async function probeSessions(ids) { return { present: ids, missing: [] } }
    export async function deleteSessions(rows, intent) { const s=globalThis.__trashTest; s.events.push('delete:'+intent); if(s.fail) throw new Error('delete failed'); return { mode: intent==='permanent'?'permanent':'trashed' } }`,
  'ui.js': `export async function confirmDialog() { const s=globalThis.__trashTest; s.events.push('confirm'); return s.confirmed }
    export function toast(message, kind) { const s=globalThis.__trashTest; s.messages.push({message,kind}); s.done.resolve() }`,
  'session-menu.js': `export function createSessionMenuExtension(callbacks) { globalThis.__trashTest.menu=callbacks; return {observe(){},scan(){},dispose(){}} }`,
  'toolbar-button.js': 'export function createToolbarButton() { return {ensure(){},setCount(){},dispose(){}} }',
  'styles.js': 'export function injectStyles() {}',
  'settings-section.js': 'export function armSettingsSection() {return ()=>{}}; export function openTrashSettingsSection() {}',
  'panel.js': 'export function openTrashPanel() {}',
  'row-identity.js': 'export function readRowIdentity() {}; export function readGroupIdentity() {}',
  'row-filter.js': `export function hideSession() {}; export function listHiddenSessions(){return []}; export function listPurgedSessions(){return []};
    export function rememberPurged(id){globalThis.__trashTest.events.push('mark:'+id)}; export function setHiddenEntries() {};
    export function sweep() {globalThis.__trashTest.sweeps++}`,
}
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/index.js', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'fake-host', setup(build) {
    build.onLoad({ filter: /src[\\/]client[\\/].*\.js$/ }, args => {
      const code = stubs[args.path.split(/[\\/]/).pop()]
      if (code !== undefined) return { contents: code, loader: 'js' }
    })
  } }],
})
const { apply } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

async function menuFixture(t, { current = 'session-a', ids = ['session-a', 'session-b'], fail = false, confirmed = true, useTrash = false } = {}) {
  const saved = Object.fromEntries(['document', 'window', 'MutationObserver', '__trashTest', '__dshSessionTrash', '__dshSessionTrashErrors'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const state = { policy: { useTrash, confirmDelete: false }, events: [], messages: [], done: deferred(), fail, confirmed, sweeps: 0, timers: [] }
  globalThis.__trashTest = state
  globalThis.document = { body: {} }
  globalThis.window = { setTimeout(fn, delay) { state.timers.push({ fn, delay }); return state.timers.length } }
  globalThis.MutationObserver = class {
    constructor(callback) { state.mutate = callback }
    observe() {}
    disconnect() {}
  }
  const snapshot = { current, ids, byId: Object.fromEntries(ids.map(id => [id, { cwd: 'same' }])) }
  const sessions = {
    list: { getSnapshot: () => snapshot },
    async open(id) { state.events.push('open:'+id); snapshot.current = id },
    async refresh() { state.events.push('refresh-list') },
  }
  const dispose = apply({ get: () => sessions, logger: () => ({ warn() {} }) })
  t.after(() => {
    dispose()
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  await flush()
  return state
}

test('关闭暂存删除当前会话：确认、切换、删除、标记、刷新顺序正确', async t => {
  const f = await menuFixture(t)
  f.menu.onTrash({ sessionId: 'session-a', title: 'A' })
  await f.done.promise
  assert.deepEqual(f.events, ['confirm', 'open:session-b', 'delete:permanent', 'mark:session-a', 'refresh-list'])
})

for (const options of [{ current: 'session-b' }, { ids: ['session-a'] }]) test('非当前会话或没有替代会话时不强行切换：' + JSON.stringify(options), async t => {
  const f = await menuFixture(t, options)
  f.menu.onTrash({ sessionId: 'session-a', title: 'A' })
  await f.done.promise
  assert.deepEqual(f.events, ['confirm', 'delete:permanent', 'mark:session-a', 'refresh-list'])
})

test('删除失败不标记已删除，也不执行成功收尾', async t => {
  const f = await menuFixture(t, { fail: true })
  f.menu.onTrash({ sessionId: 'session-a', title: 'A' })
  await f.done.promise
  assert.deepEqual(f.events, ['confirm', 'open:session-b', 'delete:permanent'])
  assert.equal(f.messages[0].kind, 'error')
})

test('取消永久删除确认不切换也不发送删除', async t => {
  const f = await menuFixture(t, { confirmed: false })
  f.menu.onTrash({ sessionId: 'session-a', title: 'A' })
  await flush()
  assert.deepEqual(f.events, ['confirm'])
  assert.equal(f.messages.length, 0)
})

test('普通软删除不进入永久删除切换流程', async t => {
  const f = await menuFixture(t, { useTrash: true })
  f.menu.onTrash({ sessionId: 'session-a', title: 'A' })
  await f.done.promise
  await flush()
  assert.deepEqual(f.events, ['delete:trash'])
})

test('工作区展开插入会话行时立即过滤，重同步仍按 300ms 合并', async t => {
  const f = await menuFixture(t)
  assert.equal(f.sweeps, 0)
  f.mutate()
  assert.equal(f.sweeps, 1)
  assert.equal(f.timers.length, 1)
  assert.equal(f.timers[0].delay, 300)
})
