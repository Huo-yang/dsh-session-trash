/**
 * 浏览器 UI 验证：用真实（无头）浏览器打开 dsh web，检查插件注入的四处 UI。
 *
 * 覆盖内容：
 * 1. 侧边栏动作条右侧出现回收站按钮（位置、可见性、未被裁掉）。
 * 2. 会话行「…」菜单里出现「删除会话」（与重命名/分叉/归档并列）。
 * 3. 回收站面板可以打开并渲染列表，且不再内嵌设置。
 * 4. 面板「设置」按钮跳转到原生设置的「会话删除」分区，并在该分区写入生效。
 * 5. **删除回归**（这块出过两次事故，断言精确到会话 id）：
 *    - 删除请求确实发到了 Host（不是只点了菜单）；
 *    - 被删的行在界面上 `display: none`，同工作区其它行不受影响；
 *    - 工作区分组与其它会话保持可见，侧边栏不崩溃。
 * 6. 页面控制台没有脚本错误。
 *
 * 回归用**列表里真实存在的一条会话**，删完立刻通过 Host API 恢复。合成会话没法
 * 用：侧边栏列表来自工作区注册表，而注册表由运行中的服务持有并回写。
 *
 * 删除 → 恢复 → 彻底删除的数据流另有 `scripts/e2e.mjs` 在 API 层覆盖。
 *
 * 用法：node scripts/ui-test.mjs --port 3082 --url-token <token>
 */
import { chromium } from 'playwright-core'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(readArg('--port') ?? 3082)
const token = readArg('--url-token') ?? ''
/** Edge 是 Windows 上稳定存在的 Chromium；避免额外下载浏览器二进制。 */
const BROWSER_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

let failures = 0
let checks = 0

/**
 * 断言并打印。
 * @param {boolean} condition 条件。
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
 * @param {string} flag 参数名。
 * @returns {string|undefined} 参数值。
 */
function readArg(flag) {
  const index = process.argv.indexOf(flag)
  return index < 0 ? undefined : process.argv[index + 1]
}

/**
 * 读出侧边栏里第一条「有行菜单」的会话标题（用于挑选演练目标）。
 * @param {import('playwright-core').Page} page 页面。
 * @returns {Promise<string>} 标题；没有可用行时为空串。
 */
async function firstActionableTitle(page) {
  return await page.evaluate(() => {
    for (const row of document.querySelectorAll('[role="treeitem"]')) {
      if (![...row.classList].some(name => name.endsWith('sessionRow'))) continue
      if (row.querySelector('button[aria-label]') === null) continue
      // 上一次运行崩在半路时，回收站里可能还留着一条会话——它的行被插件隐藏
      // （display:none），这里必须跳过，否则后续 hover 会一直等一个不可见的元素。
      if (getComputedStyle(row).display === 'none' || row.offsetParent === null) continue
      const title = row.querySelector(':scope > span[class$="title"]')?.textContent?.trim() ?? ''
      if (title !== '') return title
    }
    return ''
  })
}

/**
 * 找到标题匹配的会话行（只找可见的行）。
 * @param {import('playwright-core').Page} page 页面。
 * @param {string} title 标题。
 * @returns {Promise<import('playwright-core').Locator|null>} 行定位器。
 */
async function findRowByTitle(page, title) {
  const rows = page.locator('[role="treeitem"]:visible')
  const count = await rows.count()
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index)
    const text = ((await row.textContent()) ?? '').trim()
    if (text.includes(title)) return row
  }
  return null
}

/**
 * 读取侧边栏当前的结构统计：分组行数、会话行数（含被隐藏的）、可见会话行数。
 * @param {import('playwright-core').Page} page 页面。
 * @returns {Promise<{groups: number, sessions: number, visibleSessions: number, titles: string[], groupTitles: string[]}>} 统计。
 */
async function sidebarStats(page) {
  return await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')]
    const classify = row => ([...row.classList].some(name => name.endsWith('sessionRow')) ? 'session' : 'group')
    const sessions = rows.filter(row => classify(row) === 'session')
    const groups = rows.filter(row => classify(row) === 'group')
    // 会话行与分组行的标题元素层级不同：会话行是直接子节点，分组行在
    // `projectText` 里，因此分组用后代查询。
    const titleOf = row => row.querySelector(':scope > span[class$="title"]')?.textContent?.trim() ?? ''
    const groupTitleOf = row => {
      const direct = titleOf(row)
      if (direct !== '') return direct
      return row.querySelector('span[class$="title"]')?.textContent?.trim() ?? ''
    }
    const visible = element => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && element.offsetParent !== null
    }
    return {
      groups: groups.length,
      sessions: sessions.length,
      visibleSessions: sessions.filter(visible).length,
      titles: sessions.map(titleOf),
      groupTitles: groups.map(groupTitleOf),
    }
  })
}

/**
 * 通过行菜单删除一个标题的会话。
 * @param {import('playwright-core').Page} page 页面。
 * @param {string} title 标题。
 * @returns {Promise<boolean>} 是否完成了删除点击。
 */
/**
 * 通过行菜单删除一个标题的会话，并在确认框出现时点确认。
 * @param {import('playwright-core').Page} page 页面。
 * @param {string} title 标题。
 * @returns {Promise<{clicked: boolean, deleteRequestSent: boolean}>} 是否完成点击、是否真的发出了删除请求。
 */
async function deleteByTitleViaMenu(page, title) {
  const requests = []
  const record = request => {
    if (request.url().includes('/session-trash/delete')) requests.push(request.postData() ?? '')
  }
  page.on('request', record)
  try {
    const row = await findRowByTitle(page, title)
    if (row === null) return { clicked: false, deleteRequestSent: false }
    await row.hover()
    const trigger = row.locator('button[aria-label]')
    if (await trigger.count() === 0) return { clicked: false, deleteRequestSent: false }
    await trigger.first().click()
    await page.waitForSelector('div[role="menu"]', { timeout: 10000 })
    const deleteItem = page.locator('div[role="menu"] button[role="menuitem"]').filter({ hasText: '移入回收站' })
    if (await deleteItem.count() === 0) return { clicked: false, deleteRequestSent: false }
    await deleteItem.first().click()
    // 「移入回收站」默认不弹确认框；如果用户把策略打开过（策略持久化在回收站
    // 索引文件里），这里仍要把它点掉，否则后续断言只是在看残留状态。
    const actions = page.locator('.dst-dialog-actions .dst-button')
    const confirmDeadline = Date.now() + 3000
    while (await actions.count() === 0 && Date.now() < confirmDeadline) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    const confirmButton = actions.filter({ hasText: '移入回收站' })
    if (await confirmButton.count() > 0) await confirmButton.first().click()
    // 等真正的删除请求从网络层发出——这是「点击真的生效」的唯一硬证据。
    const deadline = Date.now() + 10000
    while (requests.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    if (requests.length === 0) return { clicked: true, deleteRequestSent: false }
    const payload = JSON.parse(requests[0])
    const sentId = payload.sessions?.[0]?.sessionId
    return { clicked: true, deleteRequestSent: typeof sentId === 'string' && sentId !== '' }
  } finally {
    page.off('request', record)
  }
}

/**
 * 等待一条新提示出现。
 * @param {import('playwright-core').Page} page 页面。
 * @param {number} previousCount 之前的提示计数。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<{count: number, last: string, tone: string}|null>} 最新提示。
 */
async function waitForToast(page, previousCount, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await page.evaluate(() => globalThis.__dshSessionTrashToasts ?? null)
    if (state !== null && state.count > previousCount) return state
    if (Date.now() > deadline) return null
    await new Promise(resolve => { setTimeout(resolve, 150) })
  }
}

/**
 * 轮询一个异步条件，直到它给出非空结果或超时。
 * @param {() => Promise<any>} probe 探测函数，未就绪时返回 null/undefined。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<any>} 探测结果，超时返回 null。
 */
async function waitFor(probe, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await probe()
    if (result !== null && result !== undefined) return result
    if (Date.now() > deadline) return null
    await new Promise(resolve => { setTimeout(resolve, 150) })
  }
}

/**
 * @param {import('playwright-core').Page} page 页面。
 * @returns {Promise<number>} 当前提示计数。
 */
async function toastCount(page) {
  const state = await page.evaluate(() => globalThis.__dshSessionTrashToasts ?? null)
  return state?.count ?? 0
}

/**
 * 读回收站按钮上的状态点：它画成什么样、数量是否被写进无障碍名。
 *
 * 用户明确要求这里**不能**是红色计数角标：红色在 DSH 里表示「有错误待处理」，
 * 而回收站会按保留期自动清理，常驻的红色数字会被读成待办。这个断言就是钉住
 * 这个决定——点必须是绿的、不含数字、尺寸很小。
 * @param {import('playwright-core').Page} page 页面。
 * @returns {Promise<object>} `{ count, display, text, background, width, height, title, ariaLabel }`。
 */
async function readTrashDot(page) {
  return await page.evaluate(() => {
    const dots = document.querySelectorAll('.dst-toolbar-dot')
    const button = document.querySelector('button[data-dsh-session-trash-button]')
    const dot = dots[0] ?? null
    const style = dot === null ? null : getComputedStyle(dot)
    // 直接问主题「success 主色 / error 主色」到底是什么，别猜 RGB。
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const token = name => {
      probe.style.background = `var(${name})`
      return getComputedStyle(probe).backgroundColor
    }
    const success = token('--dsw-alias-state-success-primary')
    const error = token('--dsw-alias-state-error-primary')
    probe.remove()
    return {
      count: dots.length,
      hidden: style === null ? null : style.display === 'none',
      text: dot === null ? null : (dot.textContent ?? ''),
      background: style === null ? null : style.backgroundColor,
      width: dot === null ? null : dot.getBoundingClientRect().width,
      height: dot === null ? null : dot.getBoundingClientRect().height,
      successToken: success,
      errorToken: error,
      title: button?.getAttribute('title') ?? null,
      ariaLabel: button?.getAttribute('aria-label') ?? null,
    }
  })
}

/**
 * 调用一个 Host 回收站端点（测试自己用，不经过界面）。
 * @param {string} endpoint 端点名。
 * @param {object|null} [body] POST 体。
 * @returns {Promise<any>} 响应体。
 */
async function callHost(endpoint, body = null) {
  const response = await fetch(`http://127.0.0.1:${String(port)}/session-trash/${endpoint}`, body === null
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return await response.json()
}

/**
 * 从工作区注册表里数一个会话出现在多少个工作区的 `sessionIds` 中。
 *
 * 直接读 `$DSH_HOME/storages/workspace.json`：这是「工作区条目有没有被摘掉」的
 * 权威依据，比看 DOM 更硬——DOM 的行还可能因为别的原因缺。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<number>} 出现次数。
 */
async function workspaceEntryCount(sessionId) {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  let document
  try {
    document = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
  } catch {
    return -1
  }
  const workspaces = document?.tables?.workspaces
  if (workspaces === null || typeof workspaces !== 'object') return -1
  let count = 0
  for (const entry of Object.values(workspaces)) {
    if (Array.isArray(entry?.sessionIds) && entry.sessionIds.includes(sessionId)) count += 1
  }
  return count
}

/**
 * 现场快照：每行会话的 id 前缀 + display + 插件隐藏集合，拼进失败信息里。
 * @param {import('playwright-core').Page} page 页面。
 * @returns {Promise<string>} 形如 `｜行: c22bbb=none, 41e444=flex｜隐藏集合: c22bbb`。
 */
async function describeRows(page) {
  const snapshot = await page.evaluate(() => ({
    rows: (globalThis.__dshSessionTrash?.inspect?.().rows ?? [])
      .map(row => `${String(row.identity?.sessionId ?? '?').slice(8, 14)}=${row.display}`),
    hidden: (globalThis.__dshSessionTrash?.inspect?.().hidden ?? []).map(id => String(id).slice(8, 14)),
  }))
  return `｜行: ${snapshot.rows.join(', ') || '无'}｜隐藏集合: ${snapshot.hidden.join(', ') || '空'}`
}

const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors = []
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', error => { consoleErrors.push(String(error)) })

// **硬保险：拦截一切会落盘删除的请求。**
//
// 这个脚本跑在真实实例的真实 `$DSH_HOME` 上。开发期间正是"测试要清场"的假设
// 让真实会话的日志被永久删除，无法恢复。所以这里从传输层下手：
//
// 1. empty、purge 和 delete 的 permanent 意图在发送前一律拦截；
// 2. `/session-trash/delete` 允许通过（软删除是这条用例要验的），但**检查它的
//    响应**：Host 只有在「暂存被关闭」时才会返回 `mode: "permanent"`，那意味着
//    刚刚真的删掉了一条真实会话的日志。这种响应会被记进 `permanentDeletes`，
//    测试结尾据此判失败——它曾经静默发生过：某次运行把「启用回收站」
//    开关留在关闭状态，随后第 9 步的「移入回收站」在 Host 侧直接落盘删除，
//    丢掉了 `session-35148e3f-…` 的日志。
const blockedRequests = []
const permanentDeletes = []
await page.route('**/session-trash/**', async route => {
  const url = route.request().url()
  if (url.endsWith('/session-trash/empty') || url.endsWith('/session-trash/purge')
    || (url.endsWith('/session-trash/delete') && route.request().postDataJSON()?.intent === 'permanent')) {
    blockedRequests.push(url)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'trash/blocked-by-test', message: '测试拦截：不允许落盘删除' } }),
    })
  }
  if (!url.endsWith('/session-trash/delete')) return route.continue()
  const response = await route.fetch()
  const body = await response.text()
  try {
    const parsed = JSON.parse(body)
    if (parsed?.value?.mode === 'permanent') {
      permanentDeletes.push(route.request().postData() ?? '')
      // 落盘删除已经发生，拦不住了；但至少把它变成一声巨响，而不是一条安静的
      // 成功提示。这里直接把响应改成失败，让界面上的断言也一起炸掉。
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'trash/test-detected-permanent', message: '测试发现落盘删除：暂存策略没有生效' } }),
      })
    }
  } catch {
    /* 非 JSON 响应交给调用方去报错 */
  }
  return route.fulfill({ response, body })
})

/**
 * 把删除策略强制拉回**不可能落盘删除**的状态。
 *
 * 第 7 步会在原生设置里真的点那个「启用回收站」开关。只要翻转回来的那
 * 一次点击没生效（或运行在中途被打断），策略就会停在 `useTrash: false`——之后
 * 任何一次「移入回收站」都会在 Host 侧直接删日志。所以凡是准备删除之前，先通过
 * Host API 把策略钉死，而不是相信界面上一次点击的结果。
 * @returns {Promise<object>} 生效后的策略。
 */
async function ensureSafePolicy() {
  const result = await callHost('policy', {
    policy: { useTrash: true, keepDays: 30, confirmDelete: false, confirmPurge: false, confirmEmpty: false, autoPurge: false },
  })
  return result.value.policy
}

/** 崩溃恢复记录：本次运行动过的、必须在下次运行开跑前还原的东西。 */
const RECOVERY_FILE = join(tmpdir(), 'dsh-session-trash-ui-test-recovery.json')

/**
 * 读崩溃恢复记录。
 * @returns {Promise<{trashed: string[], detached: string[]}>} 记录（缺失时为空）。
 */
async function readRecovery() {
  try {
    const raw = JSON.parse(await readFile(RECOVERY_FILE, 'utf8'))
    return { trashed: Array.isArray(raw?.trashed) ? raw.trashed : [], detached: Array.isArray(raw?.detached) ? raw.detached : [] }
  } catch {
    return { trashed: [], detached: [] }
  }
}

/**
 * 记下本次运行动过的会话 id，并立刻落盘。
 *
 * 测试在这里做的是**真实的**软删除与工作区摘除。运行如果被打断（Ctrl+C、断言
 * 抛错、浏览器崩），这些改动就留在真实实例上了——上一次就是这样丢掉了一条工作区
 * 条目、还把一条会话留在回收站里，导致下一次运行挑不到可见的行。落盘之后，下一次
 * 运行开头会先把它们还原。
 * @param {'trashed'|'detached'} kind 记录类别。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<void>} 写完后 resolve。
 */
async function noteRecovery(kind, sessionId) {
  const state = await readRecovery()
  if (!state[kind].includes(sessionId)) state[kind].push(sessionId)
  await writeFile(RECOVERY_FILE, JSON.stringify(state, null, 2), 'utf8')
}

/**
 * 还原上一次被打断的运行留下的改动。
 * @returns {Promise<void>} 还原完成后 resolve。
 */
async function recoverFromInterruptedRun() {
  const state = await readRecovery()
  if (state.trashed.length === 0 && state.detached.length === 0) return
  console.log(`== 0. 上一次运行被打断，先还原它留下的 ${String(state.trashed.length)} 条删除 / ${String(state.detached.length)} 条摘除 ==`)
  for (const sessionId of state.trashed) {
    const result = await callHost('restore', { sessionId })
    console.log(`  ${result.ok === true ? '已恢复' : '无需恢复'} ${sessionId}`)
  }
  for (const sessionId of state.detached) {
    const result = await callHost('reattach', { sessionId })
    console.log(`  ${result.value?.matched > 0 ? '已挂回' : '未匹配到工作区'} ${sessionId}`)
  }
  await rm(RECOVERY_FILE, { force: true })
}

// 从已知策略开始：**必须先把可能落盘删除的策略关掉，再碰任何删除路径。** 只把
// 「移入回收站前确认」关掉是不够的——真正危险的是 `useTrash` 是否为 true。
await ensureSafePolicy()
await recoverFromInterruptedRun()

try {
  console.log('== 1. 打开 GUI ==')
  await page.goto(`http://127.0.0.1:${String(port)}/?token=${token}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[role="treeitem"]', { timeout: 60000 })
  await page.waitForTimeout(2500)
  check(true, '应用已挂载并渲染出会话列表')

  console.log('== 2. 回收站入口按钮 ==')
  const trashButton = page.locator('button[data-dsh-session-trash-button]')
  check(await trashButton.count() === 1, '动作条里注入了唯一的回收站按钮')

  // 关键：DSH 里有三个都以 `headerActions` 结尾的容器（会话头部那一排、提问
  // 输入框、侧边栏工作区动作条）。所以断言必须从按钮反查它实际所在的容器，
  // 再检查该容器是否就是含「添加工作区」的那个——不能再按「最后一个」取。
  const geometry = await page.evaluate(() => {
    const button = document.querySelector('button[data-dsh-session-trash-button]')
    const add = document.querySelector('button[aria-label="添加工作区"]')
    const search = document.querySelector('button[aria-label="搜索会话"]')
    const options = document.querySelector('button[aria-label="视图选项"]')
    const headerActionsOf = (element) => {
      let node = element?.parentElement ?? null
      while (node !== null) {
        if (typeof node.className === 'string' && node.className.endsWith('headerActions')) return node
        node = node.parentElement
      }
      return null
    }
    const box = (element) => {
      if (element === null) return null
      const rect = element.getBoundingClientRect()
      return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), width: Math.round(rect.width) }
    }
    const container = headerActionsOf(button)
    return {
      container: box(container),
      containerMaxWidth: container === null ? null : getComputedStyle(container).maxWidth,
      containerChildren: container === null ? 0 : container.children.length,
      buttonIsLast: container?.lastElementChild?.hasAttribute('data-dsh-session-trash-button') === true,
      button: box(button),
      add: box(add),
      search: box(search),
      options: box(options),
      addWorkspaceInSameContainer: add !== null && headerActionsOf(add) === container,
    }
  })
  check(geometry.addWorkspaceInSameContainer, '回收站按钮与「添加工作区」在同一个动作条内（即侧边栏那一排，而非右上角会话头部）')
  check(geometry.containerChildren >= 3, `该动作条按钮数 = ${String(geometry.containerChildren)}（≥3）`)
  check(geometry.buttonIsLast, '回收站按钮位于该动作条最后（搜索 / 视图选项 / 添加工作区之后）')

  // 位置对不对只是前提，按钮必须真的**画出来**：动作条带 max-width + overflow
  // hidden，第三个按钮很容易被裁掉而 DOM 里依然存在。
  check(await trashButton.first().isVisible(), '回收站按钮可见（未被动作条裁掉）')
  check(geometry.button.width > 0, `按钮有实际尺寸（宽 ${String(geometry.button.width)}px）`)
  check(geometry.button.right <= geometry.container.right, '按钮右边界在动作条内（没有被裁掉）')
  check(geometry.button.left > geometry.add.left, '按钮排在「添加工作区」之后')
  check(
    geometry.button.top === geometry.search.top
    && geometry.button.top === geometry.options.top
    && geometry.button.top === geometry.add.top,
    '与搜索按钮、视图选项按钮、添加工作区同处一行',
  )
  check(geometry.containerMaxWidth !== '60px', `动作条宽度已放宽（max-width=${String(geometry.containerMaxWidth)}）`)

  console.log('== 2b. 状态点：绿点，不是红色数字角标 ==')
  const trashCountAtStart = (await callHost('state')).value.sessions.length
  // 起始就在回收站里的条目：可能是用户自己删的，也可能是上一次崩在中间留下的。
  // 本次运行结束时只还原**自己新删的**，这些起始条目原样留着。
  const preExistingTrashIds = (await callHost('state')).value.sessions.map(item => item.sessionId)
  const dotAtStart = await readTrashDot(page)
  check(dotAtStart.count === 1, '按钮上有一个状态点元素')
  check(dotAtStart.text === '', '状态点里没有文字（不再显示数量）')
  // 数量哪里都不显示：不在图标上，也不在悬停提示里。回收站会自己按保留期清空，
  // 把数字摆在手边只会诱导人去「清零」。
  check(!/[0-9]/.test(dotAtStart.title ?? ''), `悬停提示里也没有数量（「${String(dotAtStart.title)}」）`)
  check(!/[0-9]/.test(dotAtStart.ariaLabel ?? ''), `无障碍名里也没有数量（「${String(dotAtStart.ariaLabel)}」）`)
  check(
    dotAtStart.background !== null && dotAtStart.background !== 'rgba(0, 0, 0, 0)' && dotAtStart.background !== 'transparent',
    `状态点有实色（${String(dotAtStart.background)}）`,
  )
  // 红色是「有错误待处理」的语义，正是用户要求拿掉的东西。
  check(dotAtStart.background === dotAtStart.successToken, `状态点用的是主题 success 主色（${String(dotAtStart.background)}）`)
  check(dotAtStart.background !== dotAtStart.errorToken, `状态点不是主题的 error 红色（error=${String(dotAtStart.errorToken)}）`)
  check(dotAtStart.hidden === (trashCountAtStart === 0), `状态点显隐与回收站是否为空一致（回收站 ${String(trashCountAtStart)} 条 → ${dotAtStart.hidden ? '隐藏' : '显示'}）`)

  console.log('== 3. 会话行「…」菜单里的删除项 ==')
  // 第一行是「新会话」占位行：它还没有任何内容，DSH 因此不渲染行菜单。
  // 取第一行有动作按钮的真实会话行。
  const rowHosts = page.locator('[role="treeitem"][class*="sessionRow"]')
  const rowCount = await rowHosts.count()
  let row = null
  for (let index = 0; index < rowCount; index += 1) {
    const candidate = rowHosts.nth(index)
    if (await candidate.locator('button[aria-label]').count() === 0) continue
    // 被插件隐藏的行不能被选中：上一次崩在中间留下的回收站条目会让某一行
    // display:none，这里挑中它就只会在 hover 上白白等到超时。
    if (!await candidate.isVisible()) continue
    row = candidate
    break
  }
  check(row !== null, `找到带动作按钮的可见会话行（共 ${String(rowCount)} 行）`)
  if (row === null) throw new Error('没有可用的会话行')
  await row.hover()
  await row.locator('button[aria-label]').click()
  await page.waitForSelector('div[role="menu"]', { timeout: 10000 })
  const menuLabels = (await page.locator('div[role="menu"] button[role="menuitem"]').allTextContents())
    .map(text => text.trim())
  check(menuLabels.includes('归档会话'), `菜单含归档项（${menuLabels.join(' / ')}）`)
  check(menuLabels.includes('移入回收站'), '菜单含「移入回收站」项')
  check(menuLabels.includes('彻底删除'), '菜单含「彻底删除」项')
  check(!menuLabels.includes('删除会话'), '旧文案「删除会话」已不再出现')
  const trashItem = page.locator('div[role="menu"] button[role="menuitem"]').filter({ hasText: '移入回收站' })
  const purgeItem = page.locator('div[role="menu"] button[role="menuitem"]').filter({ hasText: '彻底删除' })
  check(await trashItem.count() === 1, '「移入回收站」只注入一次')
  check(await purgeItem.count() === 1, '「彻底删除」只注入一次')
  check(await page.locator('[data-dsh-session-trash-delete]').count() === 1, '「移入回收站」带有插件标记')
  check(await page.locator('[data-dsh-session-trash-purge]').count() === 1, '「彻底删除」带有插件标记')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // 移入回收站是可恢复动作：默认不弹确认框（点一下应直接进回收站）。
  console.log('== 3b. 「移入回收站」不弹确认框 ==')
  const actionableTitle = await firstActionableTitle(page)
  const target2 = actionableTitle === '' ? null : await findRowByTitle(page, actionableTitle)
  if (target2 === null) {
    console.log('  SKIP  没有可用的会话行')
  } else {
    // 删除之前再钉一次策略：界面上第 7 步真的动过那个开关，而「暂存关闭」时的
    // 删除在 Host 侧是直接落盘的——绝不能让一次点击的结果决定日志的存亡。
    const safePolicy = await ensureSafePolicy()
    check(safePolicy.useTrash === true, '删除前已确认暂存策略为开（不会落盘删除）')
    const toastsBefore2 = await toastCount(page)
    await target2.hover()
    await target2.locator('button[aria-label]').first().click()
    await page.waitForSelector('div[role="menu"]', { timeout: 10000 })
    await page.locator('div[role="menu"] button[role="menuitem"]').filter({ hasText: '移入回收站' }).first().click()
    await page.waitForTimeout(1500)
    check(await page.locator('.dst-dialog').count() === 0, '「移入回收站」未弹出确认框')
    const toastAfterTrash = await waitForToast(page, toastsBefore2, 8000)
    check(toastAfterTrash?.last?.includes('移入会话回收站') === true, `「移入回收站」给出结果提示（${toastAfterTrash?.last ?? '无'}）`)
    await page.keyboard.press('Escape')
    // 立刻恢复：既让后面的演练有可用的行，也顺便验证恢复这条非破坏性路径。
    const staged = (await callHost('state')).value.sessions
    for (const item of staged) await callHost('restore', { sessionId: item.sessionId })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[role="treeitem"]', { timeout: 60000 })
    await page.waitForTimeout(2500)
    check((await callHost('state')).value.sessions.length === 0, '3b 演练后已恢复，回收站为空')
  }
  await page.waitForTimeout(300)

  // 彻底删除不可恢复：必须弹确认框，且取消后什么都不该发生。
  console.log('== 3c. 「彻底删除」必须确认，取消即无副作用 ==')
  const purgeTitle = await firstActionableTitle(page)
  const target3 = purgeTitle === '' ? null : await findRowByTitle(page, purgeTitle)
  if (target3 === null) {
    console.log('  SKIP  没有可用的会话行')
  } else {
    const trashCountBefore = (await callHost('state')).value.sessions.length
    await target3.hover()
    await target3.locator('button[aria-label]').first().click()
    await page.waitForSelector('div[role="menu"]', { timeout: 10000 })
    await page.locator('div[role="menu"] button[role="menuitem"]').filter({ hasText: '彻底删除' }).first().click()
    await page.waitForSelector('.dst-dialog', { timeout: 10000 })
    const dialogText = (await page.locator('.dst-dialog').first().textContent()) ?? ''
    check(dialogText.includes('彻底删除会话'), `「彻底删除」弹出确认框（${dialogText.slice(0, 30)}…）`)
    check(dialogText.includes('无法恢复'), '确认框说明不可恢复')
    await page.locator('.dst-dialog-actions .dst-button', { hasText: '取消' }).first().click()
    await page.waitForTimeout(1200)
    check(await page.locator('.dst-dialog').count() === 0, '取消后确认框关闭')
    check(
      (await callHost('state')).value.sessions.length === trashCountBefore,
      '取消后回收站条目数不变（取消真的没做事）',
    )
  }

  console.log('== 4. 回收站面板 ==')
  await trashButton.click()
  await page.waitForSelector('.dst-dialog', { timeout: 10000 })
  check((await page.locator('.dst-dialog-title').first().textContent()) === '会话回收站', '面板标题正确')
  // 列表视图要等一次 /session-trash/state 往返：先等空态占位或条目行出现。
  await page.waitForSelector('.dst-dialog-body .dst-row, .dst-dialog-body .dst-empty', { timeout: 15000 })
  const emptyStateCount = await page.locator('.dst-dialog-body .dst-empty').count()
  const trashRowCount = await page.locator('.dst-dialog-body .dst-row').count()
  check(emptyStateCount + trashRowCount > 0, `面板列表视图已渲染（空态 ${String(emptyStateCount)} / 条目 ${String(trashRowCount)}）`)
  check((await page.locator('.dst-dialog-actions .dst-button').allTextContents()).some(text => text.trim() === '设置'), '面板有设置入口')
  // 设置不再内嵌在面板里：面板只保留列表与「清空回收站」。
  check(await page.locator('.dst-dialog-body .dst-setting-section').count() === 0, '回收站面板内不再内嵌设置')

  console.log('== 5. 面板「设置」按钮跳转到原生设置 ==')
  // 跳转的观感要盯住：面板没有「打开到某个分区」的接口，插件只能先点开、再点导航，
  // 而原生面板带 CSS 过渡——不处理的话用户会先看到它带着「通用设置」淡入再跳过去。
  // 这里在点「设置」之前装一个 10ms 采样探针：只要原生面板在**本插件分区就位之前**
  // 可见过，就算一次闪烁。（要排掉插件自己的对话框，它这时正在关闭。）
  await page.evaluate(() => {
    const probe = { flashes: 0, samples: 0, visibleWhenReady: false }
    globalThis.__dstJumpProbe = probe
    probe.timer = window.setInterval(() => {
      probe.samples += 1
      const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .find(node => !node.classList.contains('dst-dialog'))
      if (dialog === undefined) return
      const style = getComputedStyle(dialog)
      if (style.visibility === 'hidden' || style.opacity === '0' || style.display === 'none') return
      if (document.querySelector('.dst-setting-section') !== null) probe.visibleWhenReady = true
      else probe.flashes += 1
    }, 10)
  })
  await page.locator('.dst-dialog-actions .dst-button', { hasText: '设置' }).first().click()
  // 插件自己的对话框应关闭，原生设置面板打开并停到「会话删除」分区。
  await page.waitForSelector('.dst-dialog', { state: 'detached', timeout: 10000 })
  check(true, '插件面板已关闭')
  const navCell = page.locator('button', { hasText: '会话删除' }).first()
  await navCell.waitFor({ timeout: 10000 })
  const navLabel = (await navCell.textContent())?.trim() ?? ''
  check(navLabel.includes('会话删除'), `原生设置导航出现「会话删除」分区（实际：${navLabel}）`)

  console.log('== 6. 原生设置分区的内容 ==')
  // Shell 打开面板后自己会落在第一个分区（通用设置），本插件的分区在末尾，
  // 所以要等本分区的行渲染出来，再断言它已经是当前分区。
  const section = page.locator('.dst-setting-section')
  await section.locator('.dst-setting-row').first().waitFor({ timeout: 10000 })
  const activeNow = await navCell.evaluate(node => node.getAttribute('aria-current') === 'true')
  check(activeNow, '「会话删除」分区处于选中状态（已跳转到对应区域）')
  // 收尾跳转探针：闪烁必须是 0，而且探针**必须**能在就位后看到面板（否则它就是个
  // 永远为 0 的假断言）。
  const jumpProbe = await page.evaluate(() => {
    const probe = globalThis.__dstJumpProbe
    if (probe === undefined) return null
    window.clearInterval(probe.timer)
    return { flashes: probe.flashes, samples: probe.samples, visibleWhenReady: probe.visibleWhenReady }
  })
  check(
    jumpProbe !== null && jumpProbe.flashes === 0,
    `跳转过程中原生面板从未以「其它分区」的样子出现过（闪烁 ${String(jumpProbe?.flashes)} 次 / 采样 ${String(jumpProbe?.samples)} 次）`,
  )
  check(jumpProbe?.visibleWhenReady === true, '就位之后原生面板确实可见（探针本身有效）')
  const sectionText = (await section.textContent()) ?? ''
  check(sectionText.includes('启用回收站'), '分区含「是否暂存」开关')
  check(sectionText.includes('保留天数'), '分区含「暂存时间」输入')
  check(sectionText.includes('移入回收站前确认'), '分区含「移入回收站前确认」开关')
  check(sectionText.includes('回收站永久删除确认'), '分区含「回收站永久删除确认」开关')
  check(sectionText.includes('自动清理过期会话'), '分区含「自动清理」开关')
  const switches = await section.locator('.dst-switch').count()
  check(switches === 4, `分区有 ${String(switches)} 个开关（期望 4）`)
  check(await section.locator('input.dst-number').count() === 1, '分区含唯一的保留天数输入框')

  // 原生设置的其他分区仍在，插件只是追加而不是替换。
  const navLabels = (await page.locator('nav button').allTextContents()).map(text => text.trim())
  check(navLabels.some(label => label.includes('通用')), `原生设置仍含通用分区（${navLabels.join(' / ')}）`)
  check(navLabels.some(label => label.includes('会话删除')), '原生设置含追加的「会话删除」分区')

  console.log('== 7. 分区里改设置能生效 ==')
  const useTrashSwitch = section.locator('.dst-switch').first()
  const beforeChecked = await useTrashSwitch.locator('input').isChecked()
  await useTrashSwitch.click()
  await page.waitForTimeout(800)
  const afterChecked = await useTrashSwitch.locator('input').isChecked()
  check(beforeChecked !== afterChecked, `切换「启用回收站」状态变化（${String(beforeChecked)} → ${String(afterChecked)}）`)
  // 改回原值，避免影响后续运行。
  await useTrashSwitch.click()
  await page.waitForTimeout(800)
  check(await useTrashSwitch.locator('input').isChecked() === beforeChecked, '状态已改回原值')

  console.log('== 8. 关闭设置 ==')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  check(await page.locator('.dst-setting-section').count() === 0, '设置面板已关闭')

  console.log('== 9. 删除回归：只有被删的会话消失，分组与其余会话不受影响 ==')
  // 这条路径曾经出过三类事故：按标题匹配把同工作区的其它会话一起隐藏；手动摘除
  // React 的 portal 节点让整个 `sidebar.workspaces` 崩溃。回归要同时锁住这两件事，
  // 因此断言精确到会话 id，并检查同工作区其它行的 display。
  const victimTitle = await page.evaluate(() => {
    for (const row of document.querySelectorAll('[role="treeitem"][class*="sessionRow"]')) {
      const title = row.querySelector(':scope > span[class$="title"]')?.textContent?.trim() ?? ''
      if (title !== '' && row.querySelector('button[aria-label]') !== null) return title
    }
    return ''
  })
  check(victimTitle !== '', `选定回归目标会话「${victimTitle}」`)
  const trashBefore = (await callHost('state')).value.sessions.length

  const before = await sidebarStats(page)
  check(before.groups > 0, `删除前有 ${String(before.groups)} 个工作区分组`)

  // 身份读取复用插件自己的 inspect()（内部就是生产用的 readRowIdentity），
  // 不在测试里重复实现一份 fiber 遍历——重复实现会与生产路径漂移。
  const identitiesBefore = (await page.evaluate(() => globalThis.__dshSessionTrash.inspect().rows))
    .map(row => row.identity)
    .filter(identity => identity !== null)
  check(identitiesBefore.length > 0, `读到 ${String(identitiesBefore.length)} 条会话行的精确 id`)
  const victim = identitiesBefore.find(candidate => candidate.title === victimTitle)
  check(victim !== undefined, `目标会话的精确 id = ${victim?.sessionId ?? '未找到'}`)
  const survivorIds = identitiesBefore.filter(candidate => candidate.sessionId !== victim?.sessionId).map(candidate => candidate.sessionId)

  const toastsBefore = await toastCount(page)
  // 这是本套件唯一一次真实的会话删除。删之前先确认「暂存为开」——策略若为关，
  // Host 会直接落盘删除，这一步就会销毁一条真实会话。
  const safePolicyBeforeDelete = await ensureSafePolicy()
  check(safePolicyBeforeDelete.useTrash === true, '删除前已确认暂存策略为开（这一步只会软删除）')
  const deletion = await deleteByTitleViaMenu(page, victimTitle)
  check(deletion.clicked, '通过行菜单点击了「删除会话」')
  check(deletion.deleteRequestSent, '删除请求真的发到了 Host（不是只点了菜单）')
  const toastState = await waitForToast(page, toastsBefore)
  check(toastState !== null && toastState.tone === 'info', `删除后出现成功提示（实际：${toastState?.last ?? '无'}）`)
  await page.waitForTimeout(1500)

  const after = await sidebarStats(page)
  check(after.groups === before.groups, `工作区分组数量不变（${String(before.groups)} → ${String(after.groups)}）`)
  check(after.visibleSessions === before.visibleSessions - 1, `恰好少了一个可见会话（${String(before.visibleSessions)} → ${String(after.visibleSessions)}）`)
  // 列表里本来只有一条会话时，删掉它之后自然没有"剩余会话"——那不是缺陷。
  check(before.visibleSessions === 1 || after.visibleSessions >= 1,
    `侧边栏仍有可见会话（${String(before.visibleSessions)} → ${String(after.visibleSessions)}）`)
  check(after.groupTitles.some(title => title !== ''), `分组标题仍可读（${after.groupTitles.filter(Boolean).join(' / ')}）`)

  // 关键：被删的行在界面上确实不可见，而同工作区其它行的 display 一切照旧。
  // 同样复用插件的 inspect()。（「未被删除的会话仍可见」的断言放在这里之后——
  // 它需要先读到每行的 display。）
  const inspectAfter = await page.evaluate(() => globalThis.__dshSessionTrash.inspect())
  const displays = {}
  for (const row of inspectAfter.rows) {
    if (row.identity !== null) displays[row.identity.sessionId] = row.display
  }
  check(inspectAfter.hidden.includes(victim?.sessionId), `插件把目标会话记入隐藏集合（${inspectAfter.hidden.join(', ') || '空'}）`)
  check(displays[victim?.sessionId] === 'none', `被删除的行已隐藏（display=${String(displays[victim?.sessionId])}）`)
  // 未被删除的会话必须原样可见：曾经因为按标题匹配，把同工作区里标题相同的
  // 其它会话一起藏掉，用户看到的就是「没动过的会话消失了」。
  check(
    survivorIds.every(id => displays[id] !== 'none'),
    `同工作区其它会话均未被隐藏（${survivorIds.map(id => `${id.slice(8, 14)}=${String(displays[id])}`).join(', ') || '无'}）`,
  )

  const trashAfterDelete = (await callHost('state')).value.sessions
  check(trashAfterDelete.length === trashBefore + 1, `回收站条目 +1（${String(trashBefore)} → ${String(trashAfterDelete.length)}）`)
  const entry = trashAfterDelete.find(item => item.title === victimTitle)
  check(entry !== undefined, '回收站里记录了这次删除')
  check(entry?.title !== '', '回收站条目带有非空标题（空标题正是当初的触发条件）')
  // 记进崩溃恢复档案：这一步真的把一条会话放进了回收站，运行被打断时下一次运行
  // 要先把它还原，否则它会一直躺在回收站里（界面上的行也随之不可见）。
  if (victim !== undefined) await noteRecovery('trashed', victim.sessionId)

  // 状态点必须跟着变：删完之后回收站非空，按钮右上角应该亮起来。客户端刷新是
  // 异步的，所以轮询等待而不是只看一眼。
  const dotAfterDelete = await waitFor(async () => {
    const current = await readTrashDot(page)
    return current.hidden === false ? current : null
  })
  check(dotAfterDelete !== null, '删除后状态点亮起（回收站非空）')
  check(dotAfterDelete?.text === '', '状态点亮起时仍然没有数字')
  // 隐藏时状态点是 0×0，尺寸与颜色只能在真的显示出来之后量。
  check(
    dotAfterDelete !== null && dotAfterDelete.width > 0 && dotAfterDelete.width <= 10,
    `亮起时是小圆点（${String(dotAfterDelete?.width)}×${String(dotAfterDelete?.height)}px）`,
  )
  check(dotAfterDelete?.background === dotAfterDelete?.successToken, `亮起时仍是主题 success 绿（${String(dotAfterDelete?.background)}）`)
  check(
    !/[0-9]/.test(dotAfterDelete?.title ?? ''),
    `亮起后悬停提示仍然不含数量（「${String(dotAfterDelete?.title)}」）`,
  )

  console.log('== 10. 工作区条目摘除（彻底删除会做的事，但不删日志） ==')
  // 「彻底删除」除了删日志，还必须把会话从工作区条目里摘掉，否则会留下一条永远
  // 打不开的悬挂项。落盘删除在测试里被拦截，所以这里验证的是同一段注册表逻辑：
  // 先 detach 看条目是否真的消失，再 attach 挂回去——整个过程不碰任何数据。
  const detachTarget = survivorIds[0] ?? victim.sessionId
  const targetEntryBefore = await workspaceEntryCount(detachTarget)
  check(targetEntryBefore >= 1, `会话挂在 ${String(targetEntryBefore)} 个工作区条目里`)
  // 摘除是真的动了工作区注册表。先记档：运行若在这里被打断，下一次运行开头会
  // 用 reattach 把它挂回去（否则这条会话就永久失去了工作区分组）。
  await noteRecovery('detached', detachTarget)
  const detached = await callHost('detach', { sessionId: detachTarget })
  check(detached.ok === true, 'Host 摘除工作区条目成功')
  const targetEntryAfter = await workspaceEntryCount(detachTarget)
  check(targetEntryAfter === 0, `条目已从工作区摘掉（${String(targetEntryBefore)} → ${String(targetEntryAfter)}）`)
  const reattachedEarly = await callHost('reattach', { sessionId: detachTarget })
  check(reattachedEarly.ok === true, 'Host 重新挂回工作区成功')
  check(
    await workspaceEntryCount(detachTarget) === targetEntryBefore,
    `条目已挂回原位（${String(await workspaceEntryCount(detachTarget))}）`,
  )

  console.log('== 10b. 彻底删除之后：行不会掉进「未分组」区域 ==')
  // 复现用户报的现象（**不删任何数据**）。彻底删除会先把会话从工作区条目里摘掉，
  // 侧边栏因此重渲染；这条会话已经不属于任何分组，就被渲染到「未分组」下面，而它
  // 的回收站条目也已经被删掉——「按回收站隐藏」的集合里不再有它，于是行重新可见。
  // 插件的处理有两层，这里验证能验证的部分：
  //   1. **墓碑**：彻底删除过的 id 单独记住，界面残留一律隐藏。这一层完全可验证。
  //   2. **重新拉取 DSH 的会话列表**：让它真的从列表里消失，连空的「未分组」一起
  //      消失。这一层没法在这里验证到底——演练不删日志，会话在 Host 侧依然存在，
  //      重新拉取当然还会把它列出来；真实删除后才轮得到它生效。所以这里只验证
  //      「服务确实被调到、调用确实成功」，其余靠 Host 侧行为与代码审查。
  // `markPurged` 与 `refreshSessionList` 是插件的诊断钩子，都不碰任何会话数据。
  await page.evaluate(id => { globalThis.__dshSessionTrash.markPurged(id) }, detachTarget)
  const detachAgain = await callHost('detach', { sessionId: detachTarget })
  check(detachAgain.ok === true, '再次摘除工作区条目，触发侧边栏重渲染')
  const ghostRow = await waitFor(async () => {
    const row = await page.evaluate(id => {
      const rows = globalThis.__dshSessionTrash?.inspect?.().rows ?? []
      return rows.find(item => item.identity?.sessionId === id) ?? null
    }, detachTarget)
    return row !== null && row.display === 'none' ? row : null
  }, 12000)
  check(ghostRow !== null, '墓碑：重渲染到「未分组」下面的行仍然是隐藏的')
  const statsAfterGhost = await sidebarStats(page)
  // 此刻应有两条会话不可见：第 9 步移入回收站的那条，以及本次演练打上墓碑的这条。
  const expectedVisible = before.visibleSessions - 2
  check(
    statsAfterGhost.visibleSessions === expectedVisible,
    `重渲染后可见会话数没有回升（期望 ${String(expectedVisible)}，实际 ${String(statsAfterGhost.visibleSessions)}）`,
  )
  check(
    (await page.locator('[role="treeitem"]').filter({ hasText: '未分组' }).count()) > 0,
    '「未分组」分组确实出现了（说明这条会话真的被移出了原工作区）',
  )
  // 而它必须**不可见**：组成员全是我们隐藏的那些（墓碑 + 回收站 + 幽灵），DSH 渲染
  // 出来的就是一个空壳分组——用户看到的就是「莫名冒出一个未分组」。
  const ungroupedVisible = await page.evaluate(() => [...document.querySelectorAll('[role="treeitem"]')]
    .filter(item => (item.textContent ?? '').trim().startsWith('未分组'))
    .filter(item => getComputedStyle(item).display !== 'none').length)
  check(ungroupedVisible === 0, `空壳「未分组」分组被隐藏（可见 ${String(ungroupedVisible)} 个）`)
  const purgedMarked = await page.evaluate(() => globalThis.__dshSessionTrash?.inspect?.().purged ?? [])
  check(purgedMarked.includes(detachTarget), `插件把它记进墓碑集合（${purgedMarked.map(id => id.slice(8, 14)).join(', ')}）`)

  // 第二层的管线：能调到 DSH 的 `sessions.refresh()`，且调用成功。
  const refreshReached = await page.evaluate(async () => await globalThis.__dshSessionTrash.refreshSessionList())
  check(refreshReached === true, '彻底删除后的收尾能调到 DSH 的会话列表刷新（sessions.refresh）')
  const stillHidden = await page.evaluate(id => {
    const rows = globalThis.__dshSessionTrash?.inspect?.().rows ?? []
    return rows.find(item => item.identity?.sessionId === id)?.display ?? null
  }, detachTarget)
  check(
    stillHidden === null || stillHidden === 'none',
    `列表刷新之后该行依然不可见（display=${String(stillHidden)}）`,
  )

  const reattachedAfterGhost = await callHost('reattach', { sessionId: detachTarget })
  check(reattachedAfterGhost.ok === true, '演练结束后把条目挂回工作区')
  check(
    await workspaceEntryCount(detachTarget) === targetEntryBefore,
    `条目已挂回原位（${String(await workspaceEntryCount(detachTarget))}）`,
  )

  // 摘除/挂回之后，界面上的行仍应可见（会话根本没被删）。重新加载会新建一次插件
  // 实例，墓碑集合随之清空——这正是真实场景里它该失效的时机（会话列表重新从磁盘
  // 拉取，被删掉的会话本来就不在里面了）。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[role="treeitem"]', { timeout: 60000 })
  await page.waitForTimeout(3000)
  const afterDetachStats = await sidebarStats(page)
  check(afterDetachStats.groups === before.groups, `摘除演练后分组数量不变（${String(afterDetachStats.groups)}）`)
  check(afterDetachStats.visibleSessions === before.visibleSessions - 1, `摘除演练后可见会话数不变（${String(afterDetachStats.visibleSessions)}，仅第 9 步删掉的那条不可见）${await describeRows(page)}`)

  console.log('== 11. 恢复：把本次删除的会话全部还原 ==')
  // 一次运行可能删过多条（3b 的「移入回收站」演练 + 第 9 步的回归目标），全部
  // 还原。但**只还原本次运行新删的**：回收站里可能本来就有用户自己删掉的会话
  // （或上一次崩在中间留下的），把它们一并 restore 等于替用户撤销了删除。
  const trashedNow = (await callHost('state')).value.sessions
  const toRestore = trashedNow.filter(item => item.sessionId !== undefined && !preExistingTrashIds.includes(item.sessionId))
  check(toRestore.length >= 1, `回收站里有 ${String(toRestore.length)} 条本次新删的会话待恢复（删除确实进了回收站）`)
  for (const item of toRestore) {
    const restored = await callHost('restore', { sessionId: item.sessionId })
    check(restored.ok === true, `恢复 ${item.title || item.sessionId.slice(8, 16)} 成功`)
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[role="treeitem"]', { timeout: 60000 })
  await page.waitForTimeout(3500)
  const restoredStats = await sidebarStats(page)
  check(restoredStats.groups === before.groups, `恢复后分组数量一致（${String(restoredStats.groups)}）`)
  check(restoredStats.visibleSessions === before.visibleSessions, `恢复后可见会话数一致（${String(restoredStats.visibleSessions)}）${await describeRows(page)}`)
  const trashAfterRestore = (await callHost('state')).value.sessions.map(item => item.sessionId).sort()
  check(
    trashAfterRestore.join(',') === preExistingTrashIds.slice().sort().join(','),
    `回收站条目集合回到起始状态（${String(trashAfterRestore.length)} 条，起始 ${String(preExistingTrashIds.length)} 条）`,
  )

  console.log('== 10c. 彻底删除当前会话前，先切到别的会话 ==')
  // 不切的话，删除之后 DSH 会把「当前选中项」判为失效并自动新建一个空会话，用户
  // 看到的就是一片空白的新会话。这里验证切换本身能生效（同样不删任何数据）。
  // **这一步放在最后**：切换会话会让 DSH 展开目标会话所在的分组，侧边栏的可见行数
  // 因此会变（那是 DSH 的正常行为，不是插件改的），会干扰前面的计数断言。
  const listStateBeforeSwitch = await page.evaluate(() => globalThis.__dshSessionTrash.sessionListState())
  check(typeof listStateBeforeSwitch?.current === 'string', `当前打开的会话 = ${String(listStateBeforeSwitch?.current?.slice(8, 14))}`)
  const sessionCountBeforeSwitch = listStateBeforeSwitch?.ids?.length ?? 0
  const switchedTo = await page.evaluate(
    id => globalThis.__dshSessionTrash.switchAwayIfCurrent(id),
    listStateBeforeSwitch?.current,
  )
  check(switchedTo !== null && switchedTo !== listStateBeforeSwitch?.current, `已切到另一条会话（${String(switchedTo?.slice(8, 14))}）`)
  const listStateAfterSwitch = await page.evaluate(() => globalThis.__dshSessionTrash.sessionListState())
  check(listStateAfterSwitch?.current === switchedTo, '会话列表里的当前选中项已经换成新会话')
  check(
    (listStateAfterSwitch?.ids?.length ?? 0) === sessionCountBeforeSwitch,
    `切换不会新建会话（列表条数 ${String(sessionCountBeforeSwitch)} → ${String(listStateAfterSwitch?.ids?.length ?? 0)}）`,
  )
  check(
    await page.evaluate(id => globalThis.__dshSessionTrash.switchAwayIfCurrent(id), 'session-not-open') === null,
    '删的不是当前会话时不切换',
  )

  console.log('== 11. 测试自身的删除保险 ==')
  check(blockedRequests.length === 0, `没有落盘删除请求漏过拦截（拦截 ${String(blockedRequests.length)} 次）`)
  // 这条断言曾经真的抓到过事故：某次运行把「暂存」开关留在关闭状态，第 9 步的
  // 「移入回收站」在 Host 侧直接落盘删除，丢了一条真实会话的日志，而测试全绿。
  check(
    permanentDeletes.length === 0,
    permanentDeletes.length === 0
      ? '本次运行没有发生任何落盘删除（Host 从未返回 mode=permanent）'
      : `【数据事故】发生了 ${String(permanentDeletes.length)} 次落盘删除：${permanentDeletes.join(' | ')}`,
  )
  // 本次运行没有被打断，档案可以清了；策略也恢复成面向用户的默认值。
  await rm(RECOVERY_FILE, { force: true })
  await callHost('policy', {
    policy: { useTrash: true, keepDays: 30, confirmDelete: false, confirmPurge: true, confirmEmpty: true, autoPurge: true },
  })
  check(
    (await callHost('state')).value.policy.useTrash === true,
    '测试结束时恢复默认策略（暂存开、自动清理开）',
  )

  console.log('== 12. 控制台无脚本错误 ==')
  const relevant = consoleErrors.filter(text => !text.includes('favicon') && !text.includes('Failed to load resource'))
  check(relevant.length === 0, relevant.length === 0 ? '控制台无错误' : `控制台错误: ${relevant.slice(0, 3).join(' | ')}`)
} finally {
  await browser.close()
}

console.log('')
console.log(`共 ${String(checks)} 项断言，失败 ${String(failures)} 项。`)
process.exit(failures === 0 ? 0 : 1)
