import { applyProbe, hasPendingStrikes, retainProbeSessions } from './ghost-sessions.js'

/** 单请求、单定时器的探测调度器；生命周期结束后忽略在途结果。 */
export function createGhostProbe({ getIds, probe, onChanged, onError,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let disposed = false
  let inFlight = null
  let timer = null
  let lastSignature = null
  let lastProbeAt = 0

  function currentIds() {
    return [...new Set(getIds().filter(id => typeof id === 'string' && id !== ''))].sort()
  }

  function cancelRetry() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function reconcile(ids) {
    if (retainProbeSessions(ids)) onChanged()
    if (!hasPendingStrikes()) cancelRetry()
  }

  function schedule(delay) {
    if (disposed || timer !== null) return
    timer = setTimer(() => {
      timer = null
      void run(true)
    }, delay)
  }

  function run(force = false) {
    if (disposed) return Promise.resolve()
    const ids = currentIds()
    reconcile(ids)
    if (inFlight !== null) return inFlight
    const signature = JSON.stringify(ids)
    if (ids.length === 0) {
      lastSignature = signature
      return Promise.resolve()
    }
    if (!force && signature === lastSignature && now() - lastProbeAt < 5000) return Promise.resolve()
    cancelRetry()
    lastSignature = signature
    lastProbeAt = now()
    let succeeded = false
    inFlight = Promise.resolve().then(async () => {
      if (disposed) return
      const result = await probe(ids, force || hasPendingStrikes())
      if (disposed) return
      const active = currentIds()
      reconcile(active)
      const accepted = new Set(active.filter(id => ids.includes(id)))
      if (applyProbe({
        present: result.present.filter(id => accepted.has(id)),
        missing: result.missing.filter(id => accepted.has(id)),
      })) onChanged()
      succeeded = true
    }).catch(error => {
      if (!disposed) onError(error)
    }).finally(() => {
      inFlight = null
      if (disposed) return
      const active = currentIds()
      reconcile(active)
      if (active.length === 0) return
      if (JSON.stringify(active) !== signature) schedule(0)
      else if (succeeded && hasPendingStrikes()) schedule(200)
      // 失败不进入快速重试循环，交给下次正常同步。
    })
    return inFlight
  }

  return {
    run,
    dispose() {
      disposed = true
      cancelRetry()
    },
  }
}
