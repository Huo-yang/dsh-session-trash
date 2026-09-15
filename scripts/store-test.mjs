// 仅使用独立临时目录与假工作区服务，不连接正在运行的 DSH。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createTrashStore } from '../src/host/store.js'
import { createHandlers, sweepQuietly } from '../src/host/index.js'
import { applyProbe, listMissingSessions } from '../src/client/ghost-sessions.js'
import { deleteSessions, probeSessions } from '../src/client/api.js'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'

async function fixture(t) {
  const parent = resolve(tmpdir())
  const root = await mkdtemp(join(parent, 'dsh-trash-regression-'))
  t.after(async () => {
    const child = relative(parent, resolve(root))
    assert.ok(child.startsWith('dsh-trash-regression-') && !isAbsolute(child) && !child.includes('..'))
    await rm(root, { recursive: true, force: true })
  })
  let time = 1000
  const store = createTrashStore({ file: join(root, 'index.json'), sessionsRoot: join(root, 'sessions'), trashRoot: join(root, 'trash'), now: () => time })
  await mkdir(join(store.sessionsRoot, '_no-cwd'), { recursive: true })
  const workspace = { sessionIds: [], async detachSession(id) { this.sessionIds = this.sessionIds.filter(value => value !== id) } }
  const warnings = []
  const ctx = { logger: () => ({ info() {}, warn(value) { warnings.push(value) } }) }
  const registry = () => ({ list: () => [workspace] })
  async function seed(id, broken = false) {
    const path = join(store.sessionsRoot, '_no-cwd', id)
    if (broken) await writeFile(path, 'not a directory')
    else { await mkdir(path); await writeFile(join(path, 'log'), 'synthetic log') }
    await store.add([{ sessionId: id }])
    workspace.sessionIds.push(id)
    return path
  }
  return { root, store, seed, workspace, ctx, registry, warnings, handlers: createHandlers(ctx, store, registry), advance: () => { time += 31 * 86400000 } }
}

test('删除失败保留索引、日志与关联，修复条件后可以重试', async t => {
  const f = await fixture(t)
  const path = await f.seed('session-retry')
  await writeFile(f.store.trashRoot, 'blocked')
  await assert.rejects(f.handlers.purge.run({ sessionId: 'session-retry' }))
  assert.equal((await f.store.load()).sessions.length, 1)
  assert.deepEqual(f.workspace.sessionIds, ['session-retry'])
  assert.equal(await readFile(join(path, 'log'), 'utf8'), 'synthetic log')
  await rename(f.store.trashRoot, join(f.root, 'unblocked'))
  await f.handlers.purge.run({ sessionId: 'session-retry' })
  assert.equal((await f.store.load()).sessions.length, 0)
  assert.deepEqual(f.workspace.sessionIds, [])
  await assert.rejects(access(path))
})

test('清空继续处理失败项之后的会话，只摘除成功项关联', async t => {
  const f = await fixture(t)
  await f.seed('session-bad', true)
  const good = await f.seed('session-good')
  const result = await f.handlers.empty.run({})
  assert.equal(result.purged, 1)
  assert.deepEqual(result.purgedSessionIds, ['session-good'])
  assert.equal(result.failed[0].sessionId, 'session-bad')
  assert.ok(result.failed[0].message.length > 0)
  assert.deepEqual((await f.store.load()).sessions.map(x => x.sessionId), ['session-bad'])
  assert.deepEqual(f.workspace.sessionIds, ['session-bad'])
  await assert.rejects(access(good))
})

test('不在回收站的请求被拒绝且无关联副作用', async t => {
  const f = await fixture(t)
  f.workspace.sessionIds.push('session-live')
  await assert.rejects(f.handlers.purge.run({ sessionId: 'session-live' }), { code: 'trash/not-in-trash' })
  assert.deepEqual(f.workspace.sessionIds, ['session-live'])
})

for (const mode of ['manual', 'automatic']) test(`${mode} 到期清理使用成功后摘关联的流程，并保留失败项`, async t => {
  const f = await fixture(t)
  await f.seed('session-bad', true)
  await f.seed('session-expired')
  f.advance()
  await f.seed('session-young')
  if (mode === 'manual') {
    const result = await f.handlers.sweep.run({})
    assert.deepEqual(result.purged, ['session-expired'])
    assert.equal(result.failed.length, 1)
  } else {
    await sweepQuietly(f.ctx, f.store, f.registry)
    assert.equal(f.warnings.length, 1)
  }
  assert.deepEqual(f.workspace.sessionIds, ['session-bad', 'session-young'])
  assert.deepEqual((await f.store.load()).sessions.map(x => x.sessionId), ['session-bad', 'session-young'])
})

test('自动清理开关与手动强制清理', async t => {
  const f = await fixture(t)
  await f.seed('session-old')
  await f.store.updatePolicy({ autoPurge: false })
  f.advance()
  await sweepQuietly(f.ctx, f.store, f.registry)
  assert.equal((await f.store.load()).sessions.length, 1)
  assert.equal((await f.handlers.sweep.run({})).purged.length, 1)
})

test('并发策略补丁都保存', async t => {
  const f = await fixture(t)
  await Promise.all([f.store.updatePolicy({ keepDays: 7 }), f.store.updatePolicy({ autoPurge: false }), f.store.updatePolicy({ confirmDelete: true })])
  const policy = await f.store.readPolicy()
  assert.equal(policy.keepDays, 7)
  assert.equal(policy.autoPurge, false)
  assert.equal(policy.confirmDelete, true)
})

test('删除全过程占用队列，恢复不能在文件删除与索引提交之间插入', async t => {
  const f = await fixture(t)
  await f.seed('session-serial')
  let entered, release
  const started = new Promise(r => { entered = r })
  const gate = new Promise(r => { release = r })
  const purging = f.store.purge('session-serial', async () => { entered(); await gate })
  await started
  let restored = false
  const restoring = f.store.restore('session-serial').then(value => { restored = true; return value })
  await new Promise(r => setImmediate(r))
  assert.equal(restored, false)
  release()
  await purging
  assert.deepEqual(await restoring, { restored: false, reason: 'not-in-trash' })
})

test('前次已搬入暂存区的条目仍可重试删除', async t => {
  const f = await fixture(t)
  const path = await f.seed('session-staged')
  await mkdir(f.store.trashRoot)
  const staged = join(f.store.trashRoot, 'session-staged')
  await rename(path, staged)
  await f.handlers.purge.run({ sessionId: 'session-staged' })
  await assert.rejects(access(staged))
  assert.equal((await f.store.load()).sessions.length, 0)
})

test('二次探测绕过旧缓存，不误藏刚落盘的会话', async t => {
  const f = await fixture(t)
  const ids = ['session-new-regression']
  applyProbe(await f.handlers.exists.run({ sessionIds: ids }))
  await mkdir(join(f.store.sessionsRoot, '_no-cwd', ids[0]))
  assert.deepEqual((await f.store.classifySessionDirs(ids)).missing, ids)
  const fresh = await f.handlers.exists.run({ sessionIds: ids, fresh: true })
  assert.deepEqual(fresh.present, ids)
  applyProbe(fresh)
  assert.ok(!listMissingSessions().includes(ids[0]))
})

test('目录读取失败不返回 missing 结论', async t => {
  const f = await fixture(t)
  await rename(f.store.sessionsRoot, join(f.root, 'saved-sessions'))
  await writeFile(f.store.sessionsRoot, 'not a directory')
  await assert.rejects(f.handlers.exists.run({ sessionIds: ['session-live'], fresh: true }))
})

test('浏览器 API 将强制读盘参数传到 Host', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let body
  globalThis.fetch = async (_, init) => { body = JSON.parse(init.body); return { json: async () => ({ ok: true, value: { present: [], missing: [] } }) } }
  await probeSessions(['session-probe'], true)
  assert.deepEqual(body, { sessionIds: ['session-probe'], fresh: true })
})


for (const intent of ['trash', undefined]) test('策略关闭后软删除意图不升级：' + String(intent), async t => {
  const f = await fixture(t)
  const path = await f.seed('session-intent')
  await f.store.restore('session-intent')
  const before = await f.store.readPolicy()
  assert.equal(before.useTrash, true)
  // 模拟用户读完策略后，另一页面关闭暂存。
  await f.store.updatePolicy({ useTrash: false })
  const result = await f.handlers.delete.run({ sessions: [{ sessionId: 'session-intent' }], intent })
  assert.equal(result.mode, 'trashed')
  assert.equal(await readFile(join(path, 'log'), 'utf8'), 'synthetic log')
  assert.deepEqual(f.workspace.sessionIds, ['session-intent'])
})

test('已确认的永久删除不受随后开启暂存影响', async t => {
  const f = await fixture(t)
  const path = await f.seed('session-permanent')
  await f.store.updatePolicy({ useTrash: false })
  await f.store.updatePolicy({ useTrash: true })
  const result = await f.handlers.delete.run({ sessions: [{ sessionId: 'session-permanent' }], intent: 'permanent' })
  assert.equal(result.mode, 'permanent')
  await assert.rejects(access(path))
  assert.deepEqual(f.workspace.sessionIds, [])
})

test('非法删除意图无副作用', async t => {
  const f = await fixture(t)
  const path = await f.seed('session-invalid')
  await assert.rejects(f.handlers.delete.run({ sessions: [{ sessionId: 'session-invalid' }], intent: 'invalid' }), { code: 'trash/invalid-intent' })
  await access(join(path, 'log'))
  assert.equal((await f.store.load()).sessions.length, 1)
})

test('浏览器 API 固定发送软删除或永久删除意图', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const bodies = []
  globalThis.fetch = async (_, init) => { bodies.push(JSON.parse(init.body)); return { json: async () => ({ ok: true, value: {} }) } }
  await deleteSessions([{ sessionId: 'session-api' }])
  await deleteSessions([{ sessionId: 'session-api' }], 'permanent')
  assert.deepEqual(bodies.map(x => x.intent), ['trash', 'permanent'])
})

async function stageForRecovery(f, id, phase = 'staged') {
  const path = await f.seed(id)
  await mkdir(f.store.trashRoot)
  const state = JSON.parse(await readFile(f.store.file, 'utf8'))
  state.sessions[0].originalDir = path
  state.sessions[0].deletionPhase = phase
  await writeFile(f.store.file, JSON.stringify(state))
  const staged = join(f.store.trashRoot, id)
  await rename(path, staged)
  return { path, staged }
}

test('进程重启后完整暂存会话搬回准确原路径，再移除索引', async t => {
  const f = await fixture(t)
  const { path, staged } = await stageForRecovery(f, 'session-recover')
  // 用新 store 读取持久化进度，确保恢复不依赖内存。
  const restarted = createTrashStore({ file: f.store.file, sessionsRoot: f.store.sessionsRoot, trashRoot: f.store.trashRoot })
  assert.deepEqual(await restarted.restore('session-recover'), { restored: true })
  assert.equal(await readFile(join(path, 'log'), 'utf8'), 'synthetic log')
  await assert.rejects(access(staged))
  assert.equal((await restarted.load()).sessions.length, 0)
})

test('恢复目标冲突时不覆盖数据，保留暂存及索引', async t => {
  const f = await fixture(t)
  const { path, staged } = await stageForRecovery(f, 'session-conflict')
  await mkdir(path)
  await writeFile(join(path, 'log'), 'new data')
  await assert.rejects(f.store.restore('session-conflict'), /不会覆盖/)
  assert.equal(await readFile(join(path, 'log'), 'utf8'), 'new data')
  assert.equal(await readFile(join(staged, 'log'), 'utf8'), 'synthetic log')
  assert.equal((await f.store.load()).sessions.length, 1)
})

test('已经开始物理删除的会话不能误报恢复成功，仍可重试删除', async t => {
  const f = await fixture(t)
  const { staged } = await stageForRecovery(f, 'session-partial', 'deleting')
  await assert.rejects(f.store.restore('session-partial'), /无法保证完整恢复/)
  assert.equal((await f.store.load()).sessions.length, 1)
  await access(join(staged, 'log'))
  await f.handlers.purge.run({ sessionId: 'session-partial' })
  await assert.rejects(access(staged))
  assert.equal((await f.store.load()).sessions.length, 0)
})

test('无可靠原路径记录的旧暂存条目拒绝猜测恢复位置', async t => {
  const f = await fixture(t)
  const path = await f.seed('session-legacy')
  await mkdir(f.store.trashRoot)
  await rename(path, join(f.store.trashRoot, 'session-legacy'))
  await assert.rejects(f.store.restore('session-legacy'), /缺少可靠的恢复记录/)
  assert.equal((await f.store.load()).sessions.length, 1)
})

test('已丢失日志的条目恢复失败且仍保留索引', async t => {
  const f = await fixture(t)
  await f.store.add([{ sessionId: 'session-absent' }])
  await assert.rejects(f.store.restore('session-absent'), /日志不存在/)
  assert.equal((await f.store.load()).sessions.length, 1)
})

test('物理删除发生前阶段已落盘，实际删除失败后恢复被拒绝', async t => {
  const f = await fixture(t)
  const path = await f.seed('session-rm-failure')
  const staged = resolve(f.store.trashRoot, 'session-rm-failure')
  const original = fsPromises.rm
  let seen = false
  fsPromises.rm = async (target, options) => {
    if (resolve(target) === staged) {
      const saved = JSON.parse(await readFile(f.store.file, 'utf8'))
      assert.equal(saved.sessions[0].deletionPhase, 'deleting')
      assert.equal(saved.sessions[0].originalDir, resolve(path))
      seen = true
      throw new Error('injected physical deletion failure')
    }
    return original(target, options)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.handlers.purge.run({ sessionId: 'session-rm-failure' }), /injected physical/)
    assert.ok(seen)
  } finally {
    fsPromises.rm = original
    syncBuiltinESMExports()
  }
  assert.equal(await readFile(join(staged, 'log'), 'utf8'), 'synthetic log')
  await assert.rejects(f.store.restore('session-rm-failure'), /无法保证完整恢复/)
  assert.equal((await f.store.load()).sessions.length, 1)
  assert.deepEqual(f.workspace.sessionIds, ['session-rm-failure'])
})

test('搬运前原路径已落盘，搬运失败不原地删文件且仍能恢复', async t => {
  const f = await fixture(t)
  const path = await f.seed('session-rename-failure')
  const original = fsPromises.rename
  fsPromises.rename = async (source, target) => {
    if (resolve(source) === resolve(path)) {
      const saved = JSON.parse(await readFile(f.store.file, 'utf8'))
      assert.equal(saved.sessions[0].deletionPhase, 'staged')
      assert.equal(saved.sessions[0].originalDir, resolve(path))
      throw new Error('injected rename failure')
    }
    return original(source, target)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.handlers.purge.run({ sessionId: 'session-rename-failure' }), /injected rename/)
  } finally {
    fsPromises.rename = original
    syncBuiltinESMExports()
  }
  assert.equal(await readFile(join(path, 'log'), 'utf8'), 'synthetic log')
  assert.deepEqual(await f.store.restore('session-rename-failure'), { restored: true })
})

test('恢复目标越界时拒绝移动且保留暂存内容', async t => {
  const f = await fixture(t)
  const { staged } = await stageForRecovery(f, 'session-boundary')
  const saved = JSON.parse(await readFile(f.store.file, 'utf8'))
  saved.sessions[0].originalDir = join(f.root, 'outside-sessions', 'session-boundary')
  await writeFile(f.store.file, JSON.stringify(saved))
  await assert.rejects(f.store.restore('session-boundary'), /不在会话目录范围内/)
  await access(join(staged, 'log'))
  assert.equal((await f.store.load()).sessions.length, 1)
})

test('旧版暂存路径越界时拒绝递归删除', async t => {
  const f = await fixture(t)
  await f.seed('session-legacy-boundary')
  const unrelated = join(f.root, 'unrelated', 'session-legacy-boundary')
  await mkdir(unrelated, { recursive: true })
  await writeFile(join(unrelated, 'keep.txt'), 'must remain')
  const saved = JSON.parse(await readFile(f.store.file, 'utf8'))
  saved.sessions[0].trashDir = unrelated
  await writeFile(f.store.file, JSON.stringify(saved))
  await assert.rejects(f.store.purge('session-legacy-boundary'), /不在插件暂存范围内/)
  assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'must remain')
  assert.equal((await f.store.load()).sessions.length, 1)
})

test('显式永久删除的登记和清理不可被恢复请求插入', async t => {
  const f = await fixture(t)
  const path = await f.seed('session-atomic-permanent')
  await f.store.restore('session-atomic-permanent')
  let entered, release
  const started = new Promise(resolveStarted => { entered = resolveStarted })
  const gate = new Promise(resolveGate => { release = resolveGate })
  const deleting = f.store.addAndPurge([{ sessionId: 'session-atomic-permanent' }], async () => {
    entered()
    await gate
  })
  await started
  let restoreSettled = false
  const restoring = f.store.restore('session-atomic-permanent').then(result => {
    restoreSettled = true
    return result
  })
  await new Promise(resolveImmediate => setImmediate(resolveImmediate))
  assert.equal(restoreSettled, false)
  release()
  assert.deepEqual(await deleting, { purged: ['session-atomic-permanent'], failed: [] })
  assert.deepEqual(await restoring, { restored: false, reason: 'not-in-trash' })
  await assert.rejects(access(path))
})

test('原生工作区登记被移除后，插件恢复和永久删除仍保持独立', async t => {
  const f = await fixture(t)
  const path = await f.seed('session-workspace-deleted')
  f.workspace.sessionIds = [] // 等价于 DSH 原生删除工作区：只移除登记，不碰日志。
  assert.deepEqual(await f.store.restore('session-workspace-deleted'), { restored: true })
  assert.equal(await readFile(join(path, 'log'), 'utf8'), 'synthetic log')
  assert.deepEqual(f.workspace.sessionIds, [])
  await f.store.add([{ sessionId: 'session-workspace-deleted' }])
  assert.deepEqual(await f.store.purge('session-workspace-deleted'), { purged: true })
  await assert.rejects(access(path))
  assert.deepEqual(f.workspace.sessionIds, [])
})
