/**
 * 侧边栏工具栏的回收站入口。
 *
 * 位置：与「工作区搜索 / 视图选项 / 添加工作区」同一行，紧跟添加工作区之后。
 *
 * 两个必须处理的宿主约束：
 *
 * 1. **动作条不能靠类名或顺序定位。** DSH 里有三个 CSS Module 类名以
 *    `headerActions` 结尾的容器：会话骨架的头部动作区（右上角那一排：文档
 *    预览 / 右侧栏 / 轨迹）、提问输入框的动作区、以及侧边栏工作区动作条。
 *    按「文档里最后一个」取会命中右上角那个。这里改为锚定「添加工作区」
 *    按钮：它只出现在侧边栏动作条里且带固定的无障碍名，因此「从它向上找到
 *    最近的 `*_headerActions` 祖先」是唯一命中目标的定位方式。
 * 2. **动作条带 `max-width: 60px; overflow: hidden`**，正好只容纳原有的两个
 *    28px 按钮，第三个会被直接切掉。放宽宽度**不靠选择器命中宿主类名**
 *    （CSS Module 的哈希前缀与分隔符随时可能变，规则一旦不匹配就静默失效），
 *    而是把放宽后的 `max-width` 直接写成容器的内联样式，卸载时还原。
 */
import { ICON_TRASH, h, icon } from './ui.js'

/** 已注入包裹层的标记。 */
const BUTTON_ATTRIBUTE = 'data-dsh-session-trash-button'

/** 追加按钮后动作条需要的最小宽度：原有两个 28px 按钮 + 本插件按钮 + 间距。 */
const EXPANDED_MAX_WIDTH = '96px'

/** 「添加工作区」按钮的无障碍名（中/英界面各一份）；它是侧边栏动作条的稳定锚点。 */
const ADD_WORKSPACE_LABELS = ['添加工作区', 'Add workspace']

/** 记录被本插件改写过的容器及其原始内联 max-width，便于精确还原。 */
const patchedContainers = new Map()

/**
 * 判断一个元素的类名是否以 `headerActions` 结尾。
 * CSS Module 会加上哈希前缀，分隔符可能是 `-` 或 `_`，所以只比后缀。
 * @param {Element} node 候选节点。
 * @returns {boolean} 是否匹配。
 */
function isHeaderActions(node) {
  return typeof node.className === 'string' && node.className.endsWith('headerActions')
}

/**
 * 定位侧边栏的工作区动作条：从「添加工作区」按钮向上找最近的 `*_headerActions` 祖先。
 * @returns {HTMLElement|null} 动作条容器，找不到时为 `null`。
 */
function findWorkspaceActions() {
  for (const button of document.querySelectorAll('button[aria-label]')) {
    const label = button.getAttribute('aria-label')
    if (label === null || !ADD_WORKSPACE_LABELS.includes(label)) continue
    let node = button.parentElement
    while (node !== null) {
      if (node instanceof HTMLElement && isHeaderActions(node)) return node
      node = node.parentElement
    }
  }
  return null
}

/**
 * 放宽动作条的 `max-width`，让它容得下本插件按钮。
 * @param {HTMLElement} container 承载按钮的动作条。
 * @returns {void}
 */
function widenContainer(container) {
  if (patchedContainers.has(container)) return
  patchedContainers.set(container, container.style.maxWidth)
  container.style.maxWidth = EXPANDED_MAX_WIDTH
}

/** 按钮的无障碍名（中/英界面各一份）。 */
const BUTTON_LABELS = ['会话回收站', 'Session trash']

/**
 * 创建回收站入口按钮控制器。
 *
 * **按钮上的状态标记是一个点，不是红色数字角标。** 早期版本在这里挂了一个红色
 * 计数角标，但红色在 DSH 里是「有错误待处理」的语义，而回收站本身又按保留期
 * 自动清理——一个常驻的红色数字会被读成「有事情没做完」，反而干扰判断。现在只
 * 用一个绿点表示「回收站里有会话」，**数量哪里都不显示**（提示里也没有）：想
 * 知道有几条就打开面板。
 * @param {object} options 依赖。
 * @param {() => void} options.onOpen 点击回调。
 * @returns {{ensure: () => void, setCount: (count: number) => void, dispose: () => void}} 控制器。
 */
export function createToolbarButton({ onOpen }) {
  /** @type {HTMLElement|undefined} */
  let dot
  /** 按钮的本地化基础名，创建时从宿主按钮的语言推断出来。 */
  let baseLabel = BUTTON_LABELS[0]

  /**
   * 确保按钮存在于侧边栏动作条中；动作条尚未渲染或按钮已在时是空操作。
   * @returns {void}
   */
  function ensure() {
    const container = findWorkspaceActions()
    if (container === null) return
    // 宿主重渲染可能丢弃内联样式，这里每次同步都补一次。
    widenContainer(container)
    if (container.querySelector(`[${BUTTON_ATTRIBUTE}]`) !== null) return
    container.appendChild(createButton(container))
  }

  /**
   * 创建按钮节点。
   * @param {HTMLElement} container 承载按钮的动作条（用于挑选同款参考按钮）。
   * @returns {HTMLElement} 包裹层。
   */
  function createButton(container) {
    const reference = container.querySelector('button[class*="iconButton"]')
    baseLabel = readButtonLabel(reference)
    const button = h('button', {
      class: typeof reference?.className === 'string' ? reference.className : 'dst-toolbar-button',
      attrs: {
        type: 'button',
        title: baseLabel,
        'aria-label': baseLabel,
        [BUTTON_ATTRIBUTE]: '',
      },
      children: [icon(ICON_TRASH, 'dst-menu-item-icon')],
    })
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      onOpen()
    })
    dot = h('span', { class: 'dst-toolbar-dot', attrs: { 'aria-hidden': 'true' } })
    dot.style.display = 'none'
    const wrap = h('span', { class: 'dst-toolbar-wrap', children: [button, dot] })
    wrap.setAttribute(BUTTON_ATTRIBUTE, '')
    return wrap
  }

  /**
   * 从宿主按钮上读回收站入口该用的无障碍名（跟随界面语言）。
   * 宿主文案是本地化的，这里只判「有没有汉字」，不维护语言表。
   * @param {Element|null} reference 动作条里的同款原生按钮。
   * @returns {string} 基础无障碍名。
   */
  function readButtonLabel(reference) {
    const referenceLabel = reference?.getAttribute('aria-label')
    if (typeof referenceLabel === 'string' && referenceLabel !== '' && !/[\u4e00-\u9fa5]/.test(referenceLabel)) {
      return BUTTON_LABELS[1]
    }
    return BUTTON_LABELS[0]
  }

  return {
    ensure,
    /**
     * 按当前回收站条目数刷新状态标记。
     *
     * 界面上只画「有没有」（绿点），**提示里也不报数量**：回收站是个会按保留期
     * 自己清空的地方，把数字摆在手边只会诱导人去把它清零。要数量就打开面板看。
     * @param {number} count 条目数。
     * @returns {void}
     */
    setCount(count) {
      if (dot === undefined) return
      dot.style.display = count > 0 ? '' : 'none'
    },
    /** 移除按钮并还原动作条宽度。 */
    dispose() {
      for (const node of document.querySelectorAll(`[${BUTTON_ATTRIBUTE}]`)) node.remove()
      for (const [container, original] of patchedContainers) {
        container.style.maxWidth = original
      }
      patchedContainers.clear()
      dot = undefined
    },
  }
}
