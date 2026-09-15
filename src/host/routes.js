/**
 * `ctx.webServer` 上的 `/session-trash` 路由：
 *
 * - `GET  /session-trash/state`   —— 策略 + 回收站条目 + 已删除 id 列表（客户端过滤用）。
 * - `POST /session-trash/delete`  —— 删除会话；策略关闭暂存时直接彻底删除。
 * - `POST /session-trash/restore` —— 从回收站恢复。
 * - `POST /session-trash/purge`   —— 彻底删除一个会话。
 * - `POST /session-trash/empty`   —— 清空回收站。
 * - `POST /session-trash/sweep`   —— 手工触发一次到期清理。
 * - `POST /session-trash/policy`  —— 保存删除策略。
 *
 * 响应统一是 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`；
 * 业务失败用 200 + `ok:false` 表达，只有协议层错误（方法不对、报文不合法）才用 4xx。
 * 全部读写都发生在本地回环 HTTP 上，路由不注册任何跨站点可达的副作用。
 */

/** 请求体上限：策略与 id 列表都很小，超出即为异常请求。 */
const MAX_BODY_BYTES = 64 * 1024

/** 业务失败：以 200 + `ok:false` 返回，携带稳定错误码。 */
export class TrashRequestError extends Error {
  /**
   * @param {string} code 稳定错误码。
   * @param {string} message 面向用户的说明。
   */
  constructor(code, message) {
    super(message)
    this.name = 'TrashRequestError'
    this.code = code
  }
}

/**
 * 把路由实现挂到 Web 服务上。
 * @param {object} options 依赖。
 * @param {{register: (route: {kind: string, path: string, handler: Function}) => () => void}} options.webServer Web 服务。
 * @param {Record<string, {method: string, run: (payload: any) => Promise<unknown>}>} options.handlers 端点实现。
 * @returns {() => void} 卸载函数。
 */
export function registerTrashRoutes({ webServer, handlers }) {
  return webServer.register({
    kind: 'prefix',
    path: '/session-trash',
    handler: (request, response) => {
      handle(request, response, handlers).catch(error => {
        writeJson(response, 500, {
          ok: false,
          error: {
            code: 'trash/internal',
            message: error instanceof Error ? error.message : String(error),
            detail: error instanceof Error ? error.stack : undefined,
          },
        })
      })
    },
  })
}

/**
 * 分发一次请求。
 * @param {import('node:http').IncomingMessage} request 请求。
 * @param {import('node:http').ServerResponse} response 响应。
 * @param {Record<string, {method: string, run: (payload: any) => Promise<unknown>}>} handlers 端点实现。
 * @returns {Promise<void>} 处理完成后 resolve。
 */
async function handle(request, response, handlers) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const endpoint = url.pathname.slice('/session-trash'.length).replace(/^\/+|\/+$/g, '')
  const method = request.method ?? 'GET'
  const endpointHandler = handlers[endpoint]
  if (endpointHandler === undefined) {
    writeJson(response, 404, { ok: false, error: { code: 'trash/unknown-endpoint', message: `未知端点 ${endpoint}` } })
    return
  }
  if (endpointHandler.method !== method) {
    writeJson(response, 405, {
      ok: false,
      error: { code: 'trash/method-not-allowed', message: `${endpoint} 只接受 ${endpointHandler.method}` },
    })
    return
  }
  let payload = {}
  if (method === 'POST') {
    const raw = await readBody(request)
    if (raw === null) {
      writeJson(response, 413, { ok: false, error: { code: 'trash/payload-too-large', message: '请求体过大' } })
      return
    }
    if (raw.trim() !== '') {
      try {
        payload = JSON.parse(raw)
      } catch {
        writeJson(response, 400, { ok: false, error: { code: 'trash/bad-json', message: '请求体不是合法 JSON' } })
        return
      }
    }
  }
  try {
    const value = await endpointHandler.run(payload)
    writeJson(response, 200, { ok: true, value })
  } catch (error) {
    if (error instanceof TrashRequestError) {
      writeJson(response, 200, { ok: false, error: { code: error.code, message: error.message } })
      return
    }
    throw error
  }
}

/**
 * 读取请求体。
 * @param {import('node:http').IncomingMessage} request 请求。
 * @returns {Promise<string|null>} 请求体文本；超出上限时返回 `null`。
 */
async function readBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} response 响应。
 * @param {number} status HTTP 状态码。
 * @param {unknown} body 响应体。
 * @returns {void}
 */
function writeJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}
