/**
 * Host `/session-trash` API 的浏览器侧封装。
 *
 * 通讯走同源 `fetch`：Host 半边在 `ctx.webServer` 上注册了同名前缀路由，
 * 浏览器半边只需要一个稳定的端点常量，没有第二条数据通道。
 */

/** 路由前缀，与 Host 半边的注册路径一致。 */
const BASE = '/session-trash'

/**
 * 调用一个 Host 端点。
 * @param {string} endpoint 端点名（`state` / `delete` / `restore` / …）。
 * @param {object|null} [body] POST 请求体；`null` 表示 GET。
 * @returns {Promise<any>} 成功时返回 `value`。
 * @throws {TrashApiError} 网络失败、HTTP 错误或业务 `ok:false`。
 */
export async function call(endpoint, body = null) {
  const init = body === null
    ? { method: 'GET' }
    : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
  let response
  try {
    response = await fetch(`${BASE}/${endpoint}`, { ...init, credentials: 'same-origin' })
  } catch (error) {
    throw new TrashApiError('trash/offline', `无法连接会话回收站服务：${messageOf(error)}`)
  }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new TrashApiError('trash/bad-response', `响应不是合法 JSON（HTTP ${String(response.status)}）`)
  }
  if (payload === null || typeof payload !== 'object') {
    throw new TrashApiError('trash/bad-response', '响应不是对象')
  }
  if (payload.ok !== true) {
    const error = payload.error ?? {}
    throw new TrashApiError(typeof error.code === 'string' ? error.code : 'trash/unknown', typeof error.message === 'string' ? error.message : '未知错误')
  }
  return payload.value
}

/** 回收站接口失败：带稳定错误码，便于调用方区分业务失败与网络失败。 */
export class TrashApiError extends Error {
  /**
   * @param {string} code 稳定错误码。
   * @param {string} message 面向用户的说明。
   */
  constructor(code, message) {
    super(message)
    this.name = 'TrashApiError'
    this.code = code
  }
}

/**
 * 读取当前策略、回收站条目与已删除 id 列表。
 * @returns {Promise<{policy: object, sessions: object[], deletedSessionIds: string[], indexPath: string, maxKeepDays: number}>} 回收站快照。
 */
export function readState() {
  return call('state')
}

/**
 * 删除会话。
 * @param {object[]} sessions 会话元数据（`sessionId` 必填，其余用于展示）。
 * @param {'trash'|'permanent'} [intent] 用户已确认的操作意图。
 * @returns {Promise<{mode: 'trashed'|'permanent', added?: object[], removed?: string[]}>} 删除结果。
 */
export function deleteSessions(sessions, intent = 'trash') {
  return call('delete', { sessions, intent })
}

/**
 * 从回收站恢复一个会话。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<{sessionId: string}>} 结果。
 */
export function restoreSession(sessionId) {
  return call('restore', { sessionId })
}

/**
 * 彻底删除一个会话。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<{sessionId: string}>} 结果。
 */
export function purgeSession(sessionId) {
  return call('purge', { sessionId })
}

/**
 * 清空回收站。
 * @returns {Promise<{purged: number, purgedSessionIds: string[], failed: {sessionId: string, message: string}[]}>} 结果。
 */
export function emptyTrash() {
  return call('empty', {})
}

/**
 * 问 Host 一批会话的日志**此刻是否还在磁盘上**（只读）。
 *
 * 用来识别「幽灵会话」：DSH 的会话列表会一直列出一条日志已经不在磁盘上的会话，
 * 界面把它渲染成「未分组」里的残留行。见 ghost-sessions.js。
 * @param {string[]} sessionIds 会话 id。
 * @param {boolean} [fresh] 是否绕过服务端目录缓存。
 * @returns {Promise<{present: string[], missing: string[]}>} 分类结果。
 */
export function probeSessions(sessionIds, fresh = false) {
  return call('exists', { sessionIds, fresh })
}

/**
 * 保存删除策略。
 * @param {object} policy 部分或完整策略。
 * @returns {Promise<{policy: object}>} 保存后的策略。
 */
export function savePolicy(policy) {
  return call('policy', { policy })
}

/**
 * @param {unknown} error 任意异常。
 * @returns {string} 可读消息。
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
