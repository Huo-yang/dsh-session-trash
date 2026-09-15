/**
 * 删除策略的浏览器端存储。
 *
 * 设置分区是一个 React 组件，不能用「声明一个 store 再由框架绑定 hook」那套
 * （那是 DSH 内部 UI 插件的写法，要求提供 `hooks` 隔间）。这里用最小实现：
 * 一个可订阅的外部快照源，组件通过 React 自带的 `useSyncExternalStore` 读取，
 * 写入直接调用 Host 的 `/session-trash/policy`。
 */
import { readState, savePolicy } from './api.js'

/** 当前策略；`null` 表示尚未从 Host 读到。 */
let policy = null

/** 最近一次错误消息，供界面提示。 */
let error = null

/** 是否正在与 Host 通信。 */
let busy = false

/** @type {Set<() => void>} */
const listeners = new Set()

/** 缓存的快照对象；只在内容变化时替换引用。 */
let snapshot = { policy: null, busy: false, error: null }

/** 通知所有订阅者。 */
function emit() {
  for (const listener of listeners) listener()
}

/** 依据内部字段重建快照（内容变了才替换引用并通知）。 */
function refresh() {
  const next = { policy, busy, error }
  if (
    snapshot.policy === next.policy
    && snapshot.busy === next.busy
    && snapshot.error === next.error
  ) return
  snapshot = next
  emit()
}

/**
 * 订阅快照变化。
 * @param {() => void} listener 变化回调。
 * @returns {() => void} 取消订阅。
 */
export function subscribe(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 读取当前快照。引用在事实变化前保持不变，满足 `useSyncExternalStore` 的要求。
 * @returns {{policy: object|null, busy: boolean, error: string|null}} 快照。
 */
export function getSnapshot() {
  return snapshot
}

/**
 * 从 Host 拉取策略。
 * @returns {Promise<void>} 完成后 resolve。
 */
export async function loadPolicy() {
  busy = true
  refresh()
  try {
    const state = await readState()
    policy = state.policy
    error = null
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy = false
    refresh()
  }
}

/**
 * 保存一条策略改动。
 * @param {object} patch 部分策略字段。
 * @returns {Promise<void>} 完成后 resolve。
 */
export async function updatePolicy(patch) {
  // 乐观更新：开关立刻响应；失败时回滚并显示错误。
  const previous = policy
  policy = { ...(policy ?? {}), ...patch }
  busy = true
  error = null
  refresh()
  try {
    const result = await savePolicy(patch)
    policy = result.policy
  } catch (reason) {
    policy = previous
    error = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy = false
    refresh()
  }
}
