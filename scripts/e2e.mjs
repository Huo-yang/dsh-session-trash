/**
 * 端到端验证：覆盖回收站的全部 Host 端点。
 *
 * **默认不执行任何永久删除**（`purge` / `empty` / 暂存关闭时的直删）。原因是一段
 * 真实的教训：这些端点作用于**运行中实例的真实 `$DSH_HOME`**，早期版本默认执行
 * 它们，把开发机上两条真实会话的日志删掉了，无法恢复。凡是会落盘删除的断言，
 * 现在都要显式传 `--destructive` 才运行；只读与可恢复的路径（删除进回收站、
 * 恢复）照常验证。
 *
 * 用法：
 *   node scripts/e2e.mjs --port 3083             # 安全：不落盘删除
 *   node scripts/e2e.mjs --port 3083 --destructive   # 会真的删测试会话目录
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { projectDirName } from '../src/host/store.js'

/** 站点包根目录。 */
const PORT = Number(readArg('--port') ?? 3081)
const BASE = `http://127.0.0.1:${String(PORT)}/session-trash`
const DSH_HOME = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
/** 是否允许执行落盘删除。默认关闭，见文件头的说明。 */
const DESTRUCTIVE = process.argv.includes('--destructive')
/** 是否顺带清理历史测试遗留的回收站条目（只认临时目录里的 cwd）。 */
const CLEAN = process.argv.includes('--clean')

let failures = 0
let checks = 0

/**
 * 判断一个路径是否落在系统临时目录下（用于识别「这是测试造出来的会话」）。
 * @param {string} path 绝对路径。
 * @returns {boolean} 是否在临时目录下。
 */
function isUnderTemp(path) {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const root = tmpdir().replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  return normalized === root || normalized.startsWith(`${root}/`)
}

/**
 * 断言并打印结果。
 * @param {boolean} condition 断言条件。
 * @param {string} message 说明。
 * @returns {void}
 */
function check(condition, message) {
  checks += 1
  if (condition) console.log(`  PASS  ${message}`)
  else {
    failures += 1
    console.log(`  FAIL  ${message}`)
  }
}

/**
 * 调用一个回收站端点。
 * @param {string} endpoint 端点名。
 * @param {object|null} [body] POST 体；`null` 表示 GET。
 * @returns {Promise<any>} 响应体。
 */
async function callTrash(endpoint, body = null) {
  const response = await fetch(`${BASE}/${endpoint}`, body === null
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return await response.json()
}

/**
 * 取 `--flag value` 形式的命令行参数。
 * @param {string} flag 参数名。
 * @returns {string|undefined} 参数值。
 */
function readArg(flag) {
  const index = process.argv.indexOf(flag)
  return index < 0 ? undefined : process.argv[index + 1]
}

/**
 * 与会话持久化后端等价的项目目录名（直接复用 Host 实现，避免两份算法漂移）。
 * @param {string} cwd 工作目录。
 * @returns {string} 目录名。
 */
function projectKey(cwd) {
  return projectDirName(cwd)
}

/** 临时会话的工作目录（同时也是它在 sessions 下的项目目录）。 */
const TEST_CWD = await mkdtemp(join(tmpdir(), 'dsh-trash-e2e-'))
const TEST_ID = `session-${randomUUID()}`
const TEST_TITLE = `回收站测试会话 ${String(Date.now())}`
const TEST_DIR = join(DSH_HOME, 'sessions', projectKey(TEST_CWD), TEST_ID)

/**
 * 写入一个合法的会话日志文件。
 *
 * 压缩容器是「拼接的 zstd 帧」，且第一帧必须恰好是一行头部——持久化后端用
 * 首帧单独定位会话头，多行合帧会被判为损坏日志。因此这里逐行压缩再拼接。
 *
 * 只写头部：会话标题事件属于会话格式的既有词表，凭空构造容易与版本词表漂移，
 * 而回收站列表的标题来自删除请求携带的元数据（浏览器半边已经渲染过标题），
 * 不依赖日志里的标题事件。
 * @returns {Promise<void>} 写完后 resolve。
 */
async function createTestSession() {
  await mkdir(TEST_DIR, { recursive: true })
  const header = {
    type: 'session',
    version: 3,
    id: TEST_ID,
    createdAt: Date.now(),
    cwd: TEST_CWD,
    isSeeded: false,
    delegationDepth: 0,
  }
  const frame = zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
  await writeFile(join(TEST_DIR, 'session.v3.jsonl.zstd'), frame)
}

/**
 * 清理测试痕迹。
 * @returns {Promise<void>} 清理完成。
 */
async function cleanup() {
  await rm(TEST_DIR, { recursive: true, force: true })
  await rm(TEST_CWD, { recursive: true, force: true })
  // 彻底删除路径会把会话目录搬走、留下空的 <项目目录>，这里一并收尾。
  await rm(join(DSH_HOME, 'sessions', projectDirName(TEST_CWD)), { recursive: true, force: true })
}

/**
 * 清掉上次运行（尤其是被中断的运行）遗留的测试项目目录。
 *
 * 只删除名字里带本脚本临时前缀的目录，不会碰到任何真实会话。
 * @returns {Promise<void>} 清理完成。
 */
async function removeStaleTestDirs() {
  const { readdir } = await import('node:fs/promises')
  const sessionsRoot = join(DSH_HOME, 'sessions')
  let entries = []
  try {
    entries = await readdir(sessionsRoot)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.includes('dsh-trash-e2e-')) continue
    await rm(join(sessionsRoot, name), { recursive: true, force: true })
  }
}

console.log(`== 0. 准备合成会话 ==`)
await removeStaleTestDirs()
await createTestSession()
console.log(`  ${TEST_ID}`)
console.log(`  ${TEST_DIR}`)
check(existsSync(TEST_DIR), '合成会话目录已写入磁盘')

console.log(`== 1. 读取初始状态 ==`)
const initial = (await callTrash('state')).value
const beforeCount = initial.sessions.length
console.log(`  回收站初始条目数: ${String(beforeCount)}`)
check(typeof initial.policy.useTrash === 'boolean', '策略可读')

console.log(`== 2. 关闭确认与自动清理，避免测试被到期清理干扰 ==`)
await callTrash('policy', {
  policy: { useTrash: true, keepDays: 30, confirmDelete: false, confirmPurge: false, confirmEmpty: false, autoPurge: false },
})

console.log(`== 3. 软删除：移入回收站 ==`)
const deleted = (await callTrash('delete', {
  sessions: [{ sessionId: TEST_ID, title: TEST_TITLE, cwd: TEST_CWD }],
})).value
check(deleted.mode === 'trashed', '删除模式为 trashed')
let state = (await callTrash('state')).value
check(state.sessions.length === beforeCount + 1, '回收站条目数 +1')
check(state.deletedSessionIds.includes(TEST_ID), '已删除 id 列表包含合成会话')
const entry = state.sessions.find(row => row.sessionId === TEST_ID)
check(entry?.filesPresent === true, '软删除后会话文件仍在磁盘上')
check(typeof entry?.expiresAt === 'number', '存在到期时间')
check(entry?.title === TEST_TITLE, '回收站条目保留了标题')
check(existsSync(TEST_DIR), '软删除不移动任何文件')

console.log(`== 5. 幂等：重复删除同一会话 ==`)
await callTrash('delete', { sessions: [{ sessionId: TEST_ID }] })
state = (await callTrash('state')).value
check(state.sessions.length === beforeCount + 1, '重复删除不产生第二个条目')
check(state.sessions.find(row => row.sessionId === TEST_ID)?.title === TEST_TITLE, '刷新条目时保留原标题')

console.log(`== 6. 恢复 ==`)
const restored = await callTrash('restore', { sessionId: TEST_ID })
check(restored.ok === true, '恢复成功')
state = (await callTrash('state')).value
check(!state.deletedSessionIds.includes(TEST_ID), '恢复后不再出现在回收站')
check(existsSync(TEST_DIR), '恢复后会话目录仍在')

console.log(`== 7. 未知会话的业务错误 ==`)
const restoreMissing = await callTrash('restore', { sessionId: 'session-does-not-exist' })
check(restoreMissing.ok === false, '恢复未知会话返回 ok=false')
check(restoreMissing.error.code === 'trash/not-in-trash', '错误码为 trash/not-in-trash')
const purgeMissing = await callTrash('purge', { sessionId: 'session-does-not-exist' })
check(purgeMissing.error?.code === 'trash/not-in-trash', '彻底删除未知会话错误码一致')

console.log(`== 8. 协议边界 ==`)
const badJson = await fetch(`${BASE}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
check(badJson.status === 400, '非法 JSON 返回 400')
const wrongMethod = await fetch(`${BASE}/delete`, { method: 'GET' })
check(wrongMethod.status === 405, 'GET 调用 POST 端点返回 405')
const unknown = await fetch(`${BASE}/nope`)
check(unknown.status === 404, '未知端点返回 404')

console.log(`== 9. 彻底删除 ==`)
if (!DESTRUCTIVE) {
  console.log('  SKIP  需要 --destructive 才执行落盘删除')
} else {
  await callTrash('delete', { sessions: [{ sessionId: TEST_ID, title: TEST_TITLE, cwd: TEST_CWD }] })
  const purged = await callTrash('purge', { sessionId: TEST_ID })
  check(purged.ok === true, '彻底删除成功')
  check(!existsSync(TEST_DIR), '会话日志目录已从磁盘删除')
  state = (await callTrash('state')).value
  check(!state.deletedSessionIds.includes(TEST_ID), '彻底删除后不在回收站')
  check(state.sessions.length === beforeCount, '回收站条目数回到初始值')
}

console.log(`== 10. 暂存关闭时删除即彻底删除 ==`)
if (!DESTRUCTIVE) {
  console.log('  SKIP  需要 --destructive 才执行落盘删除')
} else {
  await createTestSession()
  await callTrash('policy', { policy: { useTrash: false } })
  const direct = (await callTrash('delete', { intent: 'permanent', sessions: [{ sessionId: TEST_ID, title: TEST_TITLE, cwd: TEST_CWD }] })).value
  check(direct.mode === 'permanent', '暂存关闭时删除模式为 permanent')
  check(!existsSync(TEST_DIR), '暂存关闭时会话日志被直接删除')
  state = (await callTrash('state')).value
  check(!state.deletedSessionIds.includes(TEST_ID), '暂存关闭时不留下回收站条目')
}

console.log(`== 11. 到期清理与清空回收站 ==`)
// 重新造一个测试会话并放进回收站，让这一段不依赖上游步骤留下的状态
// （--destructive 模式下前两步已经把它删掉了）。
await createTestSession()
await callTrash('policy', { policy: { useTrash: true, keepDays: 0, autoPurge: true } })
await callTrash('delete', { sessions: [{ sessionId: TEST_ID, title: TEST_TITLE, cwd: TEST_CWD }] })
const permanent = (await callTrash('state')).value.sessions.find(row => row.sessionId === TEST_ID)
check(permanent !== undefined, '测试条目已进入回收站')
check(permanent?.expiresAt === null, 'keepDays=0 表示永久保留')
const swept = (await callTrash('sweep', {})).value
check(!swept.purged.includes(TEST_ID), '永久保留的条目不会被清点删除')
// **清空回收站会删掉回收站里的一切**，包括用户自己已删除的真实会话。所以它既要
// 显式授权（`--destructive`），也要先确认回收站里**只有本测试造出来的条目**：
// 只要有一条 cwd 不在临时目录、id 也不是本次 TEST_ID，那就是用户自己的删除，
// 宁可不测这一步，也不能替用户清场。
const emptyCandidates = (await callTrash('state')).value.sessions
const foreign = emptyCandidates.filter(item =>
  item.sessionId !== TEST_ID
  && !(typeof item.cwd === 'string' && item.cwd !== '' && isUnderTemp(item.cwd)))
if (!DESTRUCTIVE) {
  console.log('  SKIP  清空回收站需要 --destructive（它会删除回收站里的所有条目）')
} else if (foreign.length > 0) {
  console.log(`  SKIP  回收站里有 ${String(foreign.length)} 条不是本测试造的条目，拒绝清空：${foreign.map(item => item.sessionId).join(', ')}`)
} else {
  const emptied = (await callTrash('empty', {})).value
  check(emptied.purged >= 1, `清空回收站删除了 ${String(emptied.purged)} 个条目`)
  check(!existsSync(TEST_DIR), '清空回收站同时删除了会话日志')
  state = (await callTrash('state')).value
  check(state.sessions.length === 0, '清空后回收站为空')
}

console.log(`== 12. 恢复默认策略 ==`)
const final = (await callTrash('policy', {
  policy: { useTrash: true, keepDays: 30, confirmDelete: false, confirmPurge: true, confirmEmpty: true, autoPurge: true },
})).value.policy
check(final.useTrash === true && final.keepDays === 30 && final.confirmDelete === false, '默认策略已恢复')

console.log(`== 13. 收尾：清掉本次测试自己留下的回收站条目 ==`)
// 安全模式不会执行 `empty`（它会删光用户已删除的真实会话），所以这里只移除
// **测试自己造出来的**条目：本次的 TEST_ID，以及（仅在 `--clean` 时）回收站里
// cwd 落在系统临时目录的那些历史遗留。用户真实会话的 cwd 永远不在临时目录里，
// 因此这条规则碰不到它们。
const trashNow = (await callTrash('state')).value.sessions
const mine = trashNow.filter(item =>
  item.sessionId === TEST_ID
  || (CLEAN && typeof item.cwd === 'string' && item.cwd !== '' && isUnderTemp(item.cwd)))
if (mine.length === 0) {
  console.log('  SKIP  没有需要清理的测试条目')
} else {
  for (const item of mine) await callTrash('purge', { sessionId: item.sessionId })
  const remaining = (await callTrash('state')).value.sessions
  check(!remaining.some(item => item.sessionId === TEST_ID), '本次测试条目已移除')
  check(
    remaining.every(item => !(CLEAN && typeof item.cwd === 'string' && isUnderTemp(item.cwd))),
    `回收站未留下测试痕迹（剩余 ${String(remaining.length)} 条）`,
  )
}

await cleanup()
console.log('')
console.log(`共 ${String(checks)} 项断言，失败 ${String(failures)} 项。`)
// fetch 的 keep-alive 连接会让进程在退出时带着未关闭的套接字触发 libuv 断言，
// 于是脚本"通过了却返回非零退出码"。先销毁连接池再退出。
try {
  const { getGlobalDispatcher } = await import('node:undici').catch(() => ({}))
  await getGlobalDispatcher?.()?.close?.()
} catch {
  /* undici 不可用时忽略：没有连接池需要关闭 */
}
process.exit(failures === 0 ? 0 : 1)
