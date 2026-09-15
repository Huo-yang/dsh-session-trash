/**
 * 无框架的 DOM 构件：元素工厂、图标、对话框与提示条。
 *
 * 浏览器半边不使用 React——它是在宿主页面已经挂载之后、以普通 DOM 操作插入
 * UI 的第三方插件。所有节点都带 `data-dsh-session-trash` 标记，便于识别与清理。
 */

/**
 * 创建元素。
 * @param {string} tag 标签名。
 * @param {object} [options] 属性与子节点。
 * @param {string} [options.class] `class` 属性。
 * @param {string} [options.text] `textContent`。
 * @param {string} [options.html] `innerHTML`（仅用于内联 SVG）。
 * @param {Record<string, string>} [options.attrs] 其他属性。
 * @param {Array<Node|string|undefined>} [options.children] 子节点，`undefined` 被跳过。
 * @param {(event: Event) => void} [options.onClick] 点击回调。
 * @returns {HTMLElement} 元素。
 */
export function h(tag, options = {}) {
  const element = document.createElement(tag)
  element.setAttribute('data-dsh-session-trash', '')
  if (options.class !== undefined) element.className = options.class
  if (options.text !== undefined) element.textContent = options.text
  if (options.html !== undefined) element.innerHTML = options.html
  for (const [name, value] of Object.entries(options.attrs ?? {})) element.setAttribute(name, value)
  for (const child of options.children ?? []) {
    if (child === undefined) continue
    element.append(child)
  }
  if (options.onClick !== undefined) element.addEventListener('click', options.onClick)
  return element
}

/** 垃圾桶线性图标，16px 网格，1.5 描边，与应用内的图标风格一致。 */
export const ICON_TRASH = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
  + '<path d="M3 4.5h10M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
  + '<path d="M4.4 4.5l.6 8.1a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.6-8.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M6.7 7v3.6M9.3 7v3.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
  + '</svg>'

/** 关闭图标。 */
export const ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
  + '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
  + '</svg>'

/** 恢复（撤销）图标。 */
export const ICON_RESTORE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
  + '<path d="M3.2 7.4a5 5 0 1 1 1.5 4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
  + '<path d="M3 3.6v3.9h3.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
  + '</svg>'

/**
 * 创建一个图标节点。
 * @param {string} svg 内联 SVG 文本。
 * @param {string} [className] 附加类名。
 * @returns {HTMLElement} 承载 SVG 的 span。
 */
export function icon(svg, className = 'dst-menu-item-icon') {
  return h('span', { class: className, html: svg })
}

/**
 * 创建一个开关控件。
 * @param {boolean} checked 初始状态。
 * @param {(next: boolean) => void} onChange 变更回调。
 * @returns {HTMLElement} 开关节点。
 */
export function toggle(checked, onChange) {
  const input = /** @type {HTMLInputElement} */ (document.createElement('input'))
  input.type = 'checkbox'
  input.checked = checked
  input.addEventListener('change', () => { onChange(input.checked) })
  // 顺序要求：导轨与滑块先渲染，透明 input 覆盖在最上层接收点击；
  // CSS 用 `input:checked ~ .track` 选择，因此 input 必须在最前。
  return h('span', {
    class: 'dst-switch',
    children: [
      input,
      h('span', { class: 'dst-switch-track' }),
      h('span', { class: 'dst-switch-thumb' }),
    ],
  })
}

/**
 * 打开一个模态对话框。
 * @param {object} options 配置。
 * @param {string} options.title 标题。
 * @param {Node} options.body 主体内容。
 * @param {Node[]} [options.footerLead] 页脚左侧的额外节点。
 * @param {Node[]} [options.actions] 页脚右侧按钮。
 * @param {() => void} [options.onClose] 关闭回调（关闭按钮、遮罩点击、Esc）。
 * @param {boolean} [options.dismissible] 是否允许通过遮罩与 Esc 关闭。
 * @returns {{close: () => void, setBody: (node: Node) => void, setFooterLead: (nodes: Node[]) => void, setActions: (nodes: Node[]) => void, element: HTMLElement}} 句柄。
 */
export function openDialog({ title, body, footerLead = [], actions = [], onClose, dismissible = true }) {
  const bodyHost = h('div', { class: 'dst-dialog-body', children: [body] })
  const leadHost = h('div', { class: 'dst-dialog-footer-lead-group' })
  const actionsHost = h('div', { class: 'dst-dialog-actions' })
  for (const node of footerLead) leadHost.appendChild(node)
  for (const node of actions) actionsHost.appendChild(node)
  const footer = h('div', { class: 'dst-dialog-footer', children: [leadHost, actionsHost] })
  const closeButton = h('button', {
    class: 'dst-button dst-button-ghost',
    attrs: { type: 'button', 'aria-label': '关闭' },
    html: ICON_CLOSE,
  })
  const header = h('div', {
    class: 'dst-dialog-header',
    children: [h('h2', { class: 'dst-dialog-title', text: title }), closeButton],
  })
  const dialog = h('div', {
    class: 'dst-dialog',
    attrs: { role: 'dialog', 'aria-modal': 'true' },
    children: [header, bodyHost, footer],
  })
  const mask = h('div', { class: 'dst-mask', children: [dialog] })

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    mask.remove()
    document.removeEventListener('keydown', onKeyDown, true)
    if (onClose !== undefined) onClose()
  }
  /**
   * @param {KeyboardEvent} event 键盘事件。
   * @returns {void}
   */
  const onKeyDown = event => {
    if (event.key !== 'Escape' || !dismissible) return
    event.stopPropagation()
    close()
  }
  closeButton.addEventListener('click', close)
  mask.addEventListener('click', event => {
    if (event.target === mask && dismissible) close()
  })
  document.addEventListener('keydown', onKeyDown, true)
  document.body.appendChild(mask)

  return {
    close,
    element: mask,
    /**
     * 替换主体内容。
     * @param {Node} node 新主体。
     * @returns {void}
     */
    setBody(node) {
      bodyHost.replaceChildren(node)
    },
    /**
     * 替换页脚左侧的说明区。
     * @param {Node[]} nodes 新节点。
     * @returns {void}
     */
    setFooterLead(nodes) {
      leadHost.replaceChildren(...nodes)
    },
    /**
     * 替换页脚右侧的动作按钮区。
     * @param {Node[]} nodes 新节点。
     * @returns {void}
     */
    setActions(nodes) {
      actionsHost.replaceChildren(...nodes)
    },
  }
}

/**
 * 打开一个确认框。
 * @param {object} options 配置。
 * @param {string} options.title 标题。
 * @param {string} options.message 说明文本。
 * @param {string} [options.confirmLabel] 确认按钮文字。
 * @param {boolean} [options.danger] 确认按钮是否为破坏性样式。
 * @returns {Promise<boolean>} 用户是否确认。
 */
export function confirmDialog({ title, message, confirmLabel = '确认', danger = true }) {
  return new Promise(resolve => {
    let settled = false
    /** @type {ReturnType<typeof openDialog>|undefined} */
    let handle
    /**
     * @param {boolean} value 结果。
     * @returns {void}
     */
    const finish = value => {
      if (settled) return
      settled = true
      handle?.close()
      resolve(value)
    }
    handle = openDialog({
      title,
      body: h('div', { class: 'dst-field-hint', text: message }),
      actions: [
        h('button', { class: 'dst-button', text: '取消', attrs: { type: 'button' }, onClick: () => { finish(false) } }),
        h('button', {
          class: `dst-button ${danger ? 'dst-button-danger' : 'dst-button-primary'}`,
          text: confirmLabel,
          attrs: { type: 'button' },
          onClick: () => { finish(true) },
        }),
      ],
      onClose: () => { finish(false) },
    })
    const primary = handle.element.querySelector('.dst-button-danger, .dst-button-primary')
    if (primary instanceof HTMLElement) primary.focus()
  })
}

/**
 * 弹出一条提示。
 * @param {string} text 提示文本。
 * @param {'info'|'error'} [tone] 语气。
 * @returns {void}
 */
export function toast(text, tone = 'info') {
  let host = document.querySelector('.dst-toast-host')
  if (host === null) {
    host = h('div', { class: 'dst-toast-host', attrs: { role: 'status', 'aria-live': 'polite' } })
    document.body.appendChild(host)
  }
  const item = h('div', { class: 'dst-toast', text, attrs: { 'data-tone': tone } })
  host.appendChild(item)
  // 计数器给自动化测试一个稳定信号：一条提示确实出现了（文案与语气可断言）。
  const counter = globalThis.__dshSessionTrashToasts ?? { count: 0, last: '', tone: 'info' }
  counter.count += 1
  counter.last = text
  counter.tone = tone
  globalThis.__dshSessionTrashToasts = counter
  window.setTimeout(() => { item.remove() }, tone === 'error' ? 6000 : 3200)
}

/**
 * 给按钮绑定一个进行中的禁用状态，避免重复提交。
 * @param {HTMLButtonElement} button 目标按钮。
 * @param {() => Promise<void>} action 异步动作。
 * @returns {void}
 */
export function runOnce(button, action) {
  if (button.disabled) return
  button.disabled = true
  action()
    .catch(() => {})
    .finally(() => { button.disabled = false })
}
