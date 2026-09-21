/**
 * 捕获 DSH AgentFactory 返回的生命周期句柄，让“彻底删除”能先完整释放 live 会话。
 *
 * DSH 0.1.5-rc.2 的 Registry 只公开裸 Agent；完整 teardown 只存在于
 * AgentHandle.dispose()。这里不修改 Registry 私有 Map，而是在 factory 边界保留同一
 * handle，并在删除期间阻止同 id 被重新 create/resume。
 */
export function installRuntimeReleaseGuard(ctx) {
  /** @type {Map<string, {agent: any, dispose: () => Promise<void>}>} */
  const handles = new Map()
  const blocked = new Set()
  let agents
  let originalCreate
  let originalResume

  const install = scope => {
    agents = scope.agents
    originalCreate = agents.create
    originalResume = agents.resume

    const wrap = (original, idOf) => async function guardedFactory(options) {
      const sessionId = idOf(options)
      if (blocked.has(sessionId)) throw new Error(`会话 ${sessionId} 正在彻底删除，不能重新加载`)
      const handle = await original.call(this, options)
      if (blocked.has(handle.agent.id)) {
        await handle.dispose()
        throw new Error(`会话 ${handle.agent.id} 正在彻底删除，不能重新加载`)
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

  return {
    /**
     * 阻止同 id 再次加载，释放 live Agent，并确认 Agent/Session Registry 均已清空。
     * 返回的 closure 必须在本次删除结束后调用以解除阻止。
     */
    async acquire(sessionId) {
      blocked.add(sessionId)
      try {
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
          throw new Error(`会话 ${sessionId} 的运行时实例释放不完整，已停止删除`)
        }
        return () => { blocked.delete(sessionId) }
      } catch (error) {
        blocked.delete(sessionId)
        throw error
      }
    },
  }
}
