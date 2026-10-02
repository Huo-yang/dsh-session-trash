import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installPolicySettings, POLICY_NAMESPACE } from '../src/host/policy-settings.js'
import { DEFAULT_POLICY } from '../src/host/policy.js'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function fixture({ user, effective, legacy }) {
  const calls = { configure: [], replace: [], mirror: [] }
  let value = { ...effective }
  const config = Object.fromEntries(Object.keys(DEFAULT_POLICY).map(key => [key, { get: () => value[key] }]))
  let revision = 1
  const descriptor = () => ({ ns: POLICY_NAMESPACE, user, revision, value: { ...value } })
  const settings = {
    configure(presentation, owner) { calls.configure.push({ presentation, owner }); return () => {} },
    describe() { return [descriptor()] },
    async replace(ns, next, expectedRevision) {
      assert.equal(ns, POLICY_NAMESPACE)
      assert.equal(expectedRevision, revision)
      calls.replace.push({ ...next })
      value = { ...next }
      user = { ...next }
      revision += 1
    },
  }
  const cleanups = []
  const child = { settings, effect(register) { const cleanup = register(); if (cleanup) cleanups.push(cleanup) } }
  const fiber = { id: 'session-trash' }
  const ctx = {
    fiber,
    inject(names, callback) { assert.deepEqual(names, ['settings']); callback(child) },
    logger() { return { warn() {} } },
  }
  const store = {
    async readPolicy() { return { ...legacy } },
    async updatePolicy(next) { const merged = { ...legacy, ...next }; calls.mirror.push(merged); return merged },
  }
  const bridge = installPolicySettings(ctx, store, config)
  return { bridge, calls, cleanup() { for (const dispose of cleanups) dispose() } }
}

test('首次加载把旧索引策略迁移到插件 Config，并关闭自动表单', async t => {
  const legacy = { ...DEFAULT_POLICY, keepDays: 9, autoPurge: false }
  const f = fixture({ user: undefined, effective: DEFAULT_POLICY, legacy })
  t.after(f.cleanup)
  await flush()
  assert.deepEqual(f.calls.configure[0].presentation, { auto: false })
  assert.deepEqual(f.calls.replace, [legacy])
  assert.deepEqual(await f.bridge.read(), legacy)
  assert.deepEqual(f.calls.mirror.at(-1), legacy)
})

test('已有插件 Config 用户层优先，保存时按修订号完整替换', async t => {
  const effective = { ...DEFAULT_POLICY, keepDays: 45, confirmDelete: true }
  const legacy = { ...DEFAULT_POLICY, keepDays: 7 }
  const f = fixture({ user: { keepDays: 45 }, effective, legacy })
  t.after(f.cleanup)
  await flush()
  assert.equal(f.calls.replace.length, 0)
  assert.deepEqual(await f.bridge.read(), effective)
  const updated = await f.bridge.update({ keepDays: 12 })
  assert.equal(updated.keepDays, 12)
  assert.equal(f.calls.replace.length, 1)
  assert.equal(f.calls.mirror.at(-1).keepDays, 12)
})
