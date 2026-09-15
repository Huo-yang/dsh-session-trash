/**
 * 会话列表过滤：把回收站里的会话从侧边栏隐藏掉。
 *
 * 删除是软删除——会话日志留在原位、条目只进索引——所以 DSH 的会话列表仍然会
 * 返回它，`workspace.sessionIds` 里也还留着它。这里在 DOM 层把那一行藏起来。
 *
 * **只按精确会话 id 匹配**，id 从行的 React fiber 上读（见 row-identity.js）。
 * 早期版本按标题匹配，结果是灾难性的：DSH 的行标题对没有持久标题的会话显示的是
 * **工作区目录名**，于是删除一条会话会把同工作区里所有同类行一起隐藏——用户看到
 * 「没动过的会话也消失了」。标题、列表序号、几何位置都不可靠，只有 id 是事实。
 *
 * **隐藏必须用 `!important`。** 第一次尝试写 `row.style.display = 'none'`，结果
 * 删除后行还在：DSH 的列表会因为 store 变化重渲染，React 重写行元素上的
 * 内联 `style`（行本身带 `style="display:flex"` 之类的声明），把普通声明覆盖掉。
 * `!important` 不会被 React 的内联样式覆盖，因此每次都重新确认一次。
 */
import { isMissingSession } from './ghost-sessions.js'
import { readGroupIdentity, readRowIdentity } from './row-identity.js'

/** 已删除会话的 id 集合（来自回收站索引，会随索引整份刷新）。 */
const hiddenSessionIds = new Set()

/**
 * 已被**彻底删除**的会话 id。
 *
 * 这份墓碑集合修的是一个真实的现象：彻底删除之后，会话行不但没消失，反而「跑到了
 * 一个未分组的工作区下面」，硬刷新才不见。原因是两件事叠在一起：
 *
 * 1. Host 会把会话从 `workspace.sessionIds` 里摘掉（否则留下点不开的悬挂条目），
 *    侧边栏因此重渲染：这条会话已经不属于任何工作区分组，就被渲染到未分组区域；
 * 2. 浏览器里缓存的会话列表仍然有它（日志刚被删，列表还没重新拉过），而这时
 *    `purge` 已经把回收站条目删掉了——`setHiddenEntries()` 用「回收站里有什么」
 *    整份覆盖隐藏集合，于是这条 id 被覆盖掉，行重新变可见。
 *
 * 所以彻底删除过的 id 必须**单独记住、永不因为回收站里没有它而忘记**：它的日志
 * 已经不在磁盘上了，任何界面上的残留都是错的。等到页面重新加载、会话列表重新
 * 从磁盘拉取时，它自然会从列表里消失，这份墓碑也就随之失效（每次加载都是新的）。
 */
const purgedSessionIds = new Set()

/** 每个被隐藏的行记录原始内联 `style` 文本，便于恢复。 */
const originalInlineStyle = new WeakMap()

/**
 * 设置完整的回收站集合。
 * @param {{sessionId: string}[]} entries 回收站条目。
 * @returns {void}
 */
export function setHiddenEntries(entries) {
  hiddenSessionIds.clear()
  for (const entry of entries) {
    // 空 id 与非法条目直接忽略，绝不把哨兵值当成匹配键。
    if (typeof entry?.sessionId === 'string' && entry.sessionId !== '') {
      hiddenSessionIds.add(entry.sessionId)
    }
  }
  sweep()
}

/**
 * 追加一个「刚刚删除」的会话 id。
 * @param {string} sessionId 会话 id。
 * @returns {void}
 */
export function hideSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  hiddenSessionIds.add(sessionId)
  sweep()
}

/**
 * 记住一个**已被彻底删除**的会话：它的日志已经不在磁盘上，浏览器缓存的列表还
 * 挂着它，因此必须一直隐藏到页面重新加载为止。
 *
 * 只在回收站那次 `setHiddenEntries()` 里出现是不够的——`purge` 之后回收站里已经
 * 没有这条了，下一轮整份刷新就会把它遗忘，行又会冒出来（见 `purgedSessionIds`）。
 * @param {string} sessionId 会话 id。
 * @returns {void}
 */
export function rememberPurged(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  purgedSessionIds.add(sessionId)
  hiddenSessionIds.delete(sessionId)
  sweep()
}

/**
 * 取消隐藏一个会话（恢复时使用）。
 *
 * **不会**取消墓碑：日志都没了的会话不存在「恢复」这回事，调用方不该有这个机会。
 * @param {string} sessionId 会话 id。
 * @returns {void}
 */
export function unhideSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  hiddenSessionIds.delete(sessionId)
  if (purgedSessionIds.has(sessionId)) return
  sweep()
}

/**
 * 判断一个元素是否属于会话行。
 *
 * **必须用类名成员判断，不能用后缀匹配。** 选中行的类名是
 * `YDXeBa_sessionRow YDXeBa_selected`，`className.endsWith('sessionRow')` 会漏掉
 * 它——而那恰好是用户当前打开、最可能去删的那一行。
 * @param {Element} row 候选行。
 * @returns {boolean} 是否为会话行。
 */
function hasSessionRowClass(row) {
  for (const name of row.classList) {
    if (name.endsWith('sessionRow')) return true
  }
  return false
}

/**
 * 判断一个会话 id 是否应该在界面上隐藏。
 *
 * 三个来源，缺一不可：
 * - `hiddenSessionIds`：回收站里的会话（软删除，日志还在）；
 * - `purgedSessionIds`：本次页面生命周期内被彻底删除的会话（日志已不在磁盘上，但
 *   浏览器缓存的列表可能还挂着它）；
 * - 幽灵会话（`ghost-sessions.js`）：经 Host 探测确认日志已不在磁盘上的会话——包括
 *   上一次运行、别的工具、或 Host 推迟移除留下的残留。
 * @param {string} sessionId 会话 id。
 * @returns {boolean} 是否隐藏。
 */
function shouldHideSession(sessionId) {
  return hiddenSessionIds.has(sessionId)
    || purgedSessionIds.has(sessionId)
    || isMissingSession(sessionId)
}

/**
 * 强制重扫一次当前列表；每次调用都会重新确认隐藏状态。
 * @returns {void}
 */
export function sweep() {
  for (const row of document.querySelectorAll('[role="treeitem"]')) {
    if (!(row instanceof HTMLElement)) continue
    if (hasSessionRowClass(row)) {
      const identity = readRowIdentity(row)
      // 读不到身份的行走「不隐藏」：宁可漏藏一个，也不能误伤——打开会话时被 React
      // 换掉的行会走到这里。
      if (identity !== null && shouldHideSession(identity.sessionId)) hideRow(row)
      else restoreInlineStyle(row)
      continue
    }
    // 分组行：只处理那个「未分组」分组，且只在它**一个可见成员都不剩**时隐藏。
    // DSH 只在有「没人认领」的会话时才会渲染这个分组，所以当它的成员全是我们隐藏的
    // 那些（回收站 + 已彻底删除 + 幽灵）时，它就是一个空壳子——用户看到的是一个莫名
    // 冒出来的「未分组」，展开还什么都没有。
    const group = readGroupIdentity(row)
    const isUngrouped = group !== null && group.workspaceId === undefined && group.label === ''
    if (isUngrouped && group.sessionIds.length > 0 && group.sessionIds.every(shouldHideSession)) hideRow(row)
    else restoreInlineStyle(row)
  }
}

/**
 * 用 `!important` 隐藏一行（React 重渲染会重写内联样式，普通声明挡不住）。
 * @param {HTMLElement} row 行节点。
 * @returns {void}
 */
function hideRow(row) {
  if (!originalInlineStyle.has(row)) originalInlineStyle.set(row, row.getAttribute('style') ?? '')
  if (row.style.getPropertyValue('display') !== 'none' || row.style.getPropertyPriority('display') !== 'important') {
    row.style.setProperty('display', 'none', 'important')
  }
}

/**
 * 读取当前隐藏集合（排查用）。
 * @returns {string[]} 已删除会话 id。
 */
export function listHiddenSessions() {
  return [...hiddenSessionIds]
}

/**
 * 读取墓碑集合（排查用）：已彻底删除、但浏览器缓存的列表里可能还挂着的会话。
 * @returns {string[]} 已彻底删除的会话 id。
 */
export function listPurgedSessions() {
  return [...purgedSessionIds]
}

/**
 * 还原一行的内联样式（此前被本插件隐藏过才有动作）。
 * @param {HTMLElement} row 会话行。
 * @returns {void}
 */
function restoreInlineStyle(row) {
  if (!originalInlineStyle.has(row)) return
  const original = originalInlineStyle.get(row) ?? ''
  originalInlineStyle.delete(row)
  const current = row.getAttribute('style') ?? ''
  if (current.includes('display: none !important')) {
    if (original === '') row.removeAttribute('style')
    else row.setAttribute('style', original)
  }
}
