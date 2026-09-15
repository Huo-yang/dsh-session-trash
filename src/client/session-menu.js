/**
 * 会话行「…」菜单的扩展：在「重命名 / 分叉 / 归档会话」之后加入「删除会话」。
 *
 * 会话行的菜单由 ui-workspace 直接渲染，没有对外暴露插槽，因此这里用一次
 * `MutationObserver` 监听菜单浮层：浮层一出现就核对它是不是会话行菜单
 * （认「归档会话」这一项），是则把删除项插到末尾。
 *
 * 菜单项的 DOM 结构是 `Menu` 基本一致的：`div[role=menu] > viewport > itemWrap > button[role=menuitem]`，
 * 类名带 CSS Module 哈希前缀（可能是 `_item` 或 `-item`，取决于构建工具），
 * 因此一律按后缀匹配，并在插入后直接借用相邻项的类名。
 *
 * 删除项携带的是**精确会话 id**（从行的 React fiber 读出，见 row-identity.js），
 * 不是标题：DSH 对没有持久标题的会话显示的是工作区目录名，按标题匹配会误伤
 * 同工作区的其它会话。
 */
import { readRowIdentity } from './row-identity.js'
import { ICON_TRASH, h, icon } from './ui.js'

/** 「移入回收站」项在 DOM 上的标识。 */
const DELETE_ITEM_ATTRIBUTE = 'data-dsh-session-trash-delete'

/** 「彻底删除」项在 DOM 上的标识。 */
const PURGE_ITEM_ATTRIBUTE = 'data-dsh-session-trash-purge'

/**
 * 最近几次行菜单触发器点击的记录（最新的在前）。
 *
 * **这是定位「菜单属于哪一行」的唯一可靠依据。** 菜单是 portal 渲染的，从浮层
 * 无法回到行；而几何匹配与类名匹配都不可靠：DSH 在菜单打开时会给行换一套
 * class（`sessionRow` 会消失），DOM 里还同时存在工作区分组行与其它会话行。
 * 用户点的一定是某一行的「…」按钮，所以在 `capture` 阶段把它记下来。
 * 只保留最近几条，并在使用时跳过已从文档里移除的节点。
 * @type {{trigger: Element, row: HTMLElement}[]}
 */
const lastTriggered = []

/** 保留的最近点击条数。 */
const TRIGGER_HISTORY = 5

/**
 * 记录一次行菜单触发器的点击（文档级 `capture` 监听，先于 React 的处理器）。
 * @param {Event} event 点击事件。
 * @returns {void}
 */
function rememberTriggerClick(event) {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest('button[aria-label]')
  if (button === null) return
  const row = button.closest('[role="treeitem"]')
  if (!(row instanceof HTMLElement)) return
  const existing = lastTriggered.findIndex(entry => entry.trigger === button)
  if (existing >= 0) lastTriggered.splice(existing, 1)
  lastTriggered.unshift({ trigger: button, row })
  if (lastTriggered.length > TRIGGER_HISTORY) lastTriggered.length = TRIGGER_HISTORY
}

/**
 * 判断一个元素是否带指定后缀的 CSS Module 类名。
 * @param {Element} element 目标元素。
 * @param {string} suffix 类名后缀，例如 `item`。
 * @returns {boolean} 是否匹配。
 */
function hasClassSuffix(element, suffix) {
  const className = element.className
  return typeof className === 'string' && className.endsWith(suffix)
}

/**
 * 创建一个菜单项节点，复刻 `Menu` 的 DOM 结构。
 * @param {string} label 项文本。
 * @param {string} iconHtml 图标 SVG。
 * @param {string} attribute 用于标记该项的 `data-*` 属性名。
 * @returns {HTMLElement} 包裹层。
 */
function menuItem(label, iconHtml, attribute) {
  return h('div', {
    class: 'dst-menu-item-wrap',
    attrs: { [attribute]: '' },
    children: [
      h('button', {
        class: 'dst-menu-item',
        attrs: { type: 'button', role: 'menuitem' },
        children: [icon(iconHtml), h('span', { class: 'dst-menu-item-label', text: label })],
      }),
    ],
  })
}

/**
 * 把本插件的菜单项装扮成与相邻项完全一致：直接借用「归档会话」那一项的类名。
 * @param {HTMLElement} item 本插件的菜单项包裹层。
 * @param {HTMLElement} archive 归档项按钮。
 * @returns {void}
 */
function adoptMenuStyles(item, archive) {
  const itemButton = item.querySelector('button')
  const archiveWrap = archive.parentElement
  if (itemButton !== null && typeof archive.className === 'string') itemButton.className = archive.className
  if (archiveWrap !== null && typeof archiveWrap.className === 'string' && itemButton !== null) {
    itemButton.parentElement.className = archiveWrap.className
  }
  const iconHost = itemButton?.querySelector('span')
  const archiveIcon = archive.querySelector('[class$="itemIcon"]')
  if (iconHost != null && archiveIcon !== null && typeof archiveIcon.className === 'string') {
    iconHost.className = archiveIcon.className
  }
  const label = itemButton?.querySelector('span:last-child')
  const archiveLabel = archive.querySelector('[class$="itemLabel"]')
  if (label != null && archiveLabel !== null && typeof archiveLabel.className === 'string') {
    label.className = archiveLabel.className
  }
}
/**
 * 创建会话菜单扩展。
 *
 * 两个动作，风险不同、处理方式也不同：
 * - **移入回收站**：低风险、可恢复，不弹确认框（设置里可开）；
 * - **彻底删除**：不可恢复，永远先确认。
 * @param {object} options 依赖。
 * @param {(identity: {sessionId: string, title: string}) => void} options.onTrash 移入回收站。
 * @param {(identity: {sessionId: string, title: string}) => void} options.onPurge 彻底删除。
 * @returns {{observe: () => void, scan: () => void, dispose: () => void}} 生命周期句柄。
 */
export function createSessionMenuExtension({ onTrash, onPurge }) {
  /** @type {MutationObserver|undefined} */
  let observer

  /**
   * 处理一个新增节点，看它是不是刚打开的会话菜单浮层。
   * @param {Node} node 新增节点。
   * @returns {void}
   */
  function handleNode(node) {
    if (!(node instanceof HTMLElement)) return
    try {
      for (const list of collectMenuLists(node)) decorateMenuList(list)
    } catch (error) {
      // 插件注入失败绝不能让宿主界面崩溃：记到诊断数组并放弃这一次注入。
      const bucket = globalThis.__dshSessionTrashErrors ?? []
      bucket.push({ where: 'session-menu', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : '' })
      globalThis.__dshSessionTrashErrors = bucket
    }
  }

  /**
   * 收集一个节点内（含自身）的菜单浮层。
   * @param {HTMLElement} node 起始节点。
   * @returns {HTMLElement[]} 菜单浮层，可能为空。
   */
  function collectMenuLists(node) {
    const found = []
    if (isMenuList(node)) found.push(node)
    for (const candidate of node.querySelectorAll('div[role="menu"]')) {
      if (candidate instanceof HTMLElement && isMenuList(candidate)) found.push(candidate)
    }
    return found
  }

  /**
   * 判断一个节点是不是菜单浮层。
   * `Menu` 把浮层 portal 到 `document.body`，所以它出现时通常本身就是被插入的
   * 节点；同时兼容浮层被包在别的容器里一起插入的情况。
   * @param {HTMLElement} node 候选节点。
   * @returns {boolean} 是否为菜单浮层。
   */
  function isMenuList(node) {
    return node.getAttribute('role') === 'menu' && node.querySelector('button[role="menuitem"]') !== null
  }

  /**
   * 扫描文档里当前打开的全部菜单浮层，补上删除项。
   * @returns {void}
   */
  function scanMenus() {
    for (const candidate of document.querySelectorAll('div[role="menu"]')) {
      if (candidate instanceof HTMLElement) decorateMenuList(candidate)
    }
  }

  /**
   * 给一个会话菜单补上删除项。不是会话菜单时不动。
   *
   * 宿主行来自 {@link rowByTrigger}：用户点的那个「…」按钮在 `capture` 阶段就
   * 被记下了它所属的行。菜单浮层本身是 portal 节点，且行在菜单打开后会换一套
   * class，所以任何「打开后从浮层反查行」的办法都不可靠。
   * @param {HTMLElement} list 菜单浮层。
   * @param {boolean} [retried] 本次调用是否为推迟后的重试。
   * @returns {void}
   */
  function decorateMenuList(list, retried = false) {
    if (!list.isConnected) return
    if (list.querySelector(`[${DELETE_ITEM_ATTRIBUTE}]`) !== null) return
    const buttons = [...list.querySelectorAll('button[role="menuitem"]')]
    const archive = buttons.find(button => button.textContent?.trim() === '归档会话')
    if (archive === undefined) return
    const row = findOwningSessionRow()
    if (row === null) {
      // 触发器点击可能晚于浮层插入（React 的提交顺序），下一帧再试一次。
      if (!retried) requestAnimationFrame(() => { decorateMenuList(list, true) })
      return
    }
    const identity = readRowIdentity(row)
    if (identity === null) return

    const host = archive.parentElement?.parentElement
    if (host === null || host === undefined) return
    // 两个动作分开呈现：移入回收站可恢复，彻底删除不可恢复。
    host.appendChild(buildItem({
      label: '移入回收站',
      attribute: DELETE_ITEM_ATTRIBUTE,
      onActivate: () => { onTrash(identity) },
    }, archive, list))
    host.appendChild(buildItem({
      label: '彻底删除',
      attribute: PURGE_ITEM_ATTRIBUTE,
      onActivate: () => { onPurge(identity) },
    }, archive, list))
  }

  /**
   * 构造一个本插件的菜单项。
   * @param {{label: string, attribute: string, onActivate: () => void}} spec 项的定义。
   * @param {HTMLElement} archive 相邻的「归档会话」按钮，用于借用样式。
   * @param {HTMLElement} list 菜单浮层。
   * @returns {HTMLElement} 菜单项包裹层。
   */
  function buildItem(spec, archive, list) {
    const item = menuItem(spec.label, ICON_TRASH, spec.attribute)
    adoptMenuStyles(item, archive)
    const button = item.querySelector('button')
    if (button === null) return item
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      // **不要手动移除浮层。** 菜单是 React portal 渲染的节点，从 DOM 里摘掉它
      // 会让 React 之后卸载时执行 `removeChild` 失败（NotFoundError），整个
      // `sidebar.workspaces` 槽位随之崩溃、侧边栏清空。让 React 自己处理关闭：
      // 这里只派发一次外部点击信号，等价于用户点了别处。
      closeMenu(list)
      spec.onActivate()
    })
    return item
  }

  /**
   * 请求关闭一个菜单浮层。
   *
   * 只对浮层之外派发一次 `pointerdown`：`Menu` 自己的文档级监听会因此关闭菜单，
   * 而且不会碰 React 拥有的节点。`list.remove()` 那种直接摘除会破坏 React 的
   * 卸载流程（见调用点的注释）。
   * @param {HTMLElement} list 菜单浮层。
   * @returns {void}
   */
  function closeMenu(list) {
    list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }))
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }))
  }

  /**
   * 找出刚刚打开的行菜单所属的会话行。
   *
   * 依据是 {@link lastTriggered}：文档级 `capture` 监听在用户点击「…」时记下了
   * 触发器与它的行。取最近一条且仍在文档里的记录；行在菜单打开后可能被 React
   * 换成新节点，因此同时接受「触发器仍在、行已换」的情况——那种情况下用触发器
   * 现在的祖先重新取一次行。
   * @returns {HTMLElement|null} 会话行，找不到时为 `null`。
   */
  function findOwningSessionRow() {
    for (const entry of lastTriggered) {
      if (!entry.trigger.isConnected) continue
      const current = entry.trigger.closest('[role="treeitem"]')
      if (current instanceof HTMLElement) return current
      if (entry.row.isConnected) return entry.row
    }
    return null
  }

  return {
    /** 开始观察文档，并补上已经打开的菜单。 */
    observe() {
      // capture 阶段先于 React 的处理器执行，确保打开菜单时行已被记录。
      document.addEventListener('click', rememberTriggerClick, true)
      observer = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) handleNode(node)
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      scanMenus()
    },
    /** 立即扫描一次（菜单浮层的插入时机不确定时由调用方补一次）。 */
    scan: scanMenus,
    /** 停止观察并移除已插入的节点。 */
    dispose() {
      document.removeEventListener('click', rememberTriggerClick, true)
      observer?.disconnect()
      observer = undefined
      for (const node of document.querySelectorAll(`[${DELETE_ITEM_ATTRIBUTE}], [${PURGE_ITEM_ATTRIBUTE}]`)) node.remove()
    },
  }
}
