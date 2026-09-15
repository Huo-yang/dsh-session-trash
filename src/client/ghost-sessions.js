/**
 * 幽灵会话：DSH 的会话列表里挂着、但日志**已经不在磁盘上**的会话。
 *
 * 为什么需要这一层：DSH 没有删除会话的功能，所以「列表里有一条日志已经没了的会话」
 * 这条路径上游从没被走过。实测（用合成会话走真实的「彻底删除」流程）有两种表现：
 *
 * 1. 会话**从未被打开**过：删除后 Host 会广播移除，客户端随即把它从列表里丢掉，
 *    界面干净。
 * 2. 会话**正被打开**（在客户端有常驻实例）：Host 把移除**推迟**了——它仍然出现在
 *    会话列表里，只是不再属于任何工作区分组。于是侧边栏把它渲染到「未分组」下面：
 *    用户看到的就是「删掉的会话跑到了一个未分组的工作区里」。这种情况下连
 *    `sessions.refresh()` 都拉不掉它（Host 权威列表还在返回它），只有客户端重新加载
 *    才干净。而且它会**累积**：多次删除后「未分组」里会堆着好几条这样的会话。
 *
 * 上游那条路我们改不了，所以这里换一个判据：**直接问 Host 这些会话的日志还在不在**
 * （`/session-trash/exists`，只读）。不在磁盘上的会话，界面上一律隐藏——它本来就打
 * 不开了，留着只会误导。这个判据不依赖「谁删的」，因此也能清掉历史遗留的幽灵。
 *
 * 判定要连续两次确认才生效：会话刚创建的那一瞬间目录可能还没落盘，一次误判就会把
 * 一条正常会话藏起来；两次确认能挡住这种竞态。
 */

/** 会话 id → 连续被判定为「日志不存在」的次数。 */
const missingStrikes = new Map()

/** 已确认是幽灵的会话 id。 */
const missingSessionIds = new Set()

/** 需要连续命中几次才认定为幽灵。 */
const STRIKES_REQUIRED = 2

/** 清理已经退出当前列表的记录，避免失效的一次命中永久触发复测。 */
export function retainProbeSessions(sessionIds) {
  const active = new Set(sessionIds)
  let changed = false
  for (const id of missingStrikes.keys()) {
    if (!active.has(id)) missingStrikes.delete(id)
  }
  for (const id of missingSessionIds) {
    if (!active.has(id)) {
      missingSessionIds.delete(id)
      changed = true
    }
  }
  return changed
}

/**
 * 用一次探测结果更新幽灵集合。
 *
 * 只处理请求里出现过的 id：不在列表里的旧结论保持不动（探测是按「当前列表」发起的，
 * 列表里没有的 id 本来也不影响界面）。
 * @param {{present: string[], missing: string[]}} probe Host 探测结果。
 * @returns {boolean} 幽灵集合是否发生了变化。
 */
export function applyProbe(probe) {
  let changed = false
  for (const id of probe.present ?? []) {
    if (missingStrikes.delete(id)) changed = true
    if (missingSessionIds.delete(id)) changed = true
  }
  for (const id of probe.missing ?? []) {
    const strikes = (missingStrikes.get(id) ?? 0) + 1
    missingStrikes.set(id, strikes)
    if (strikes < STRIKES_REQUIRED) continue
    if (!missingSessionIds.has(id)) {
      missingSessionIds.add(id)
      changed = true
    }
  }
  return changed
}

/**
 * 一个会话 id 是否已被认定为幽灵。
 * @param {string} sessionId 会话 id。
 * @returns {boolean} 是否日志已不在磁盘上。
 */
export function isMissingSession(sessionId) {
  return missingSessionIds.has(sessionId)
}

/**
 * 当前幽灵集合（排查用）。
 * @returns {string[]} 会话 id。
 */
export function listMissingSessions() {
  return [...missingSessionIds]
}

/**
 * 是否还有「只命中一次、等待第二次确认」的会话。
 *
 * 调用方用它安排一次**立刻**的复测：二次确认是为了防竞态，但如果要等下一个限流窗口
 * （5 秒）才复测，用户就会先看到一个空的「未分组」分组再看着它消失。这里让它 200ms
 * 后立刻复测，把窗口压到几百毫秒。
 * @returns {boolean} 是否有待确认的会话。
 */
export function hasPendingStrikes() {
  for (const strikes of missingStrikes.values()) {
    if (strikes < STRIKES_REQUIRED) return true
  }
  return false
}
