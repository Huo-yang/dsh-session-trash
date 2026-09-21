import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installRuntimeReleaseGuard } from '../src/host/runtime.js'

function fixture() {
  const liveAgents = new Map()
  const liveSessions = new Map()
  const listeners = new Map()
  const agents = {
    get: id => liveAgents.get(id),
    async create(options) { return publish(options.sessionId) },
    async resume(options) { return publish(options.resumeSessionId) },
  }
  function publish(id) {
    const agent = { id }
    liveAgents.set(id, agent)
    liveSessions.set(id, { id })
    return {
      agent,
      async dispose() {
        liveAgents.delete(id)
        liveSessions.delete(id)
        listeners.get('agent/disposed')?.({ agent })
      },
    }
  }
  const ctx = {
    inject(names, callback) { callback({ agents }) },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) },
    get(name) { return name === 'agents' ? agents : name === 'sessions' ? { get: id => liveSessions.get(id) } : undefined },
  }
  return { ctx, agents, liveAgents, liveSessions }
}

test('释放被捕获的 live handle，并在删除窗口内阻止同 id 重新加载', async () => {
  const f = fixture()
  const guard = installRuntimeReleaseGuard(f.ctx)
  await f.agents.resume({ resumeSessionId: 'session-live' })
  assert.ok(f.liveAgents.has('session-live'))
  const release = await guard.acquire('session-live')
  assert.equal(f.liveAgents.has('session-live'), false)
  assert.equal(f.liveSessions.has('session-live'), false)
  await assert.rejects(f.agents.resume({ resumeSessionId: 'session-live' }), /正在彻底删除/)
  release()
  await f.agents.resume({ resumeSessionId: 'session-live' })
  assert.ok(f.liveAgents.has('session-live'))
})

test('启动前已存在且没有 handle 的 live 会话拒绝物理删除', async () => {
  const f = fixture()
  const agent = { id: 'session-untracked' }
  f.liveAgents.set(agent.id, agent)
  f.liveSessions.set(agent.id, { id: agent.id })
  const guard = installRuntimeReleaseGuard(f.ctx)
  await assert.rejects(guard.acquire(agent.id), /请重启 DSH 后重试/)
  assert.equal(f.liveAgents.get(agent.id), agent)
})

test('冷会话无需 handle，仍在文件删除期间阻止同 id 激活', async () => {
  const f = fixture()
  const guard = installRuntimeReleaseGuard(f.ctx)
  const release = await guard.acquire('session-cold')
  await assert.rejects(f.agents.create({ sessionId: 'session-cold' }), /正在彻底删除/)
  release()
  await f.agents.create({ sessionId: 'session-cold' })
  assert.ok(f.liveAgents.has('session-cold'))
})

test('移入回收站释放 live 会话并持续阻止，恢复后允许再次加载', async () => {
  const f = fixture()
  const guard = installRuntimeReleaseGuard(f.ctx)
  await guard.initialize([])
  await f.agents.create({ sessionId: 'session-trashed' })
  await guard.trash('session-trashed')
  assert.equal(f.liveAgents.has('session-trashed'), false)
  assert.equal(f.liveSessions.has('session-trashed'), false)
  await assert.rejects(f.agents.resume({ resumeSessionId: 'session-trashed' }), /位于回收站/)
  await guard.untrash('session-trashed')
  await f.agents.resume({ resumeSessionId: 'session-trashed' })
  assert.ok(f.liveAgents.has('session-trashed'))
})

test('启动时从索引恢复回收站阻止集合', async () => {
  const f = fixture()
  const guard = installRuntimeReleaseGuard(f.ctx)
  await guard.initialize(['session-from-index'])
  await assert.rejects(f.agents.resume({ resumeSessionId: 'session-from-index' }), /位于回收站/)
  await guard.untrash('session-from-index')
  await f.agents.resume({ resumeSessionId: 'session-from-index' })
  assert.ok(f.liveAgents.has('session-from-index'))
})

test('运行时释放失败时撤销新回收站阻止', async () => {
  const f = fixture()
  const agent = { id: 'session-untracked-trash' }
  f.liveAgents.set(agent.id, agent)
  f.liveSessions.set(agent.id, { id: agent.id })
  const guard = installRuntimeReleaseGuard(f.ctx)
  await assert.rejects(guard.trash(agent.id), /请重启 DSH 后重试/)
  f.liveAgents.delete(agent.id)
  f.liveSessions.delete(agent.id)
  await f.agents.resume({ resumeSessionId: agent.id })
  assert.ok(f.liveAgents.has(agent.id))
})
