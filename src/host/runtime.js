/**
 * 捕获 DSH AgentFactory 返回的生命周期句柄，让进入回收站或彻底删除的会话先完整释放。
 *
 * DSH 0.1.5-rc.2 的 Registry 只公开裸 Agent；完整 teardown 只存在于
 * AgentHandle.dispose()。这里不修改 Registry 私有 Map，而是在 factory 边界保留同一
 * handle，并在回收站期间或物理删除期间阻止同 id 被重新 create/resume。
 */
export function installRuntimeReleaseGuard(ctx) {
  /** @type {Map<string, {agent: any, dispose: () => Promise<void>}>} */
  const handles = new Map()
  const trashed = new Set()
  const deleting = new Set()
  let ready = Promise.resolve()
  let agents
  let originalCreate
  let originalResume

  const install = scope => {
    agents = scope.agents
    originalCreate = agents.create
    originalResume = agents.resume

    const wrap = (original, idOf) => async function guardedFactory(options) {
      const sessionId = idOf(options)
      await ready
      if (trashed.has(sessionId) || deleting.has(sessionId)) throw blockedError(sessionId)
      const handle = await original.call(this, options)
      if (trashed.has(handle.agent.id) || deleting.has(handle.agent.id)) {
        await handle.dispose()
        throw blockedError(handle.agent.id)
      }
      handles.set(handle.agent.id, handle)
      return handle
    }

    const create = wrap(originalCreate, options => options?.sessionId)
    const resume = wrap(originalResume, options => options?.resumeSessionId)
    agents.create = create
    agents.resume = resume
    return () => {
      if (agents.create === create) agents.create = originalCreate
      if (agents.resume === resume) agents.resume = originalResume
      handles.clear()
    }
  }

  ctx.inject(['agents'], install)
  ctx.on('agent/disposed', ({ agent }) => handles.delete(agent.id))

  async function disposeAndVerify(sessionId) {
    const live = agents?.get(sessionId) ?? ctx.get('agents')?.get(sessionId)
    if (live !== undefined) {
      const handle = handles.get(sessionId)
      if (handle === undefined || handle.agent !== live) {
        throw new Error(`会话 ${sessionId} 已加载，但当前 DSH 未提供可安全释放的句柄；请重启 DSH 后重试`)
      }
      await handle.dispose()
    }
    const agentRegistry = agents ?? ctx.get('agents')
    const sessionRegistry = ctx.get('sessions')
    if (agentRegistry?.get(sessionId) !== undefined || sessionRegistry?.get(sessionId) !== undefined) {
      throw new Error(`会话 ${sessionId} 的运行时实例释放不完整，已停止操作`)
    }
  }

  return {
    /** 启动时从持久化回收站索引恢复长期阻止集合。 */
    initialize(sessionIds) {
      ready = Promise.resolve(sessionIds).then(ids => {
        for (const id of ids) trashed.add(id)
      })
      return ready
    },

    /** 将会话标为回收站状态并释放 live 实例；失败时撤销本次新增的阻止。 */
    async trash(sessionId) {
      await ready
      const added = !trashed.has(sessionId)
      trashed.add(sessionId)
      try {
        await disposeAndVerify(sessionId)
        return () => { if (added) trashed.delete(sessionId) }
      } catch (error) {
        if (added) trashed.delete(sessionId)
        throw error
      }
    },

    /** 恢复或彻底删除完成后解除回收站状态。 */
    async untrash(sessionId) {
      await ready
      trashed.delete(sessionId)
    },

    /**
     * 阻止同 id 再次加载，释放 live Agent，并确认 Agent/Session Registry 均已清空。
     * 返回的 closure 必须在本次删除结束后调用以解除阻止。
     */
    async acquire(sessionId) {
      await ready
      deleting.add(sessionId)
      try {
        await disposeAndVerify(sessionId)
        return () => { deleting.delete(sessionId) }
      } catch (error) {
        deleting.delete(sessionId)
        throw error
      }
    },
  }
}

function blockedError(sessionId) {
  return new Error(`会话 ${sessionId} 位于回收站或正在彻底删除，不能重新加载`)
}
