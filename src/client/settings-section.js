/**
 * 「会话删除」设置分区：把删除策略作为**原生设置的一个分区**注册进 DSH 设置面板，
 * 与「通用 / 模型 / 插件」并列，而不是塞在回收站自己的对话框里。
 *
 * 注册路径是 DSH 的官方 UI 扩展点：`ctx.slots.inject('settings.general.item', …)`
 * 的兄弟形式 `ctx.slots.inject('settings.section', …)`。分区自己拥有标题、行与
 * 说明文字，Shell 只负责渲染导航项与内容列。
 *
 * 两个不同于 DSH 内部插件的约束：
 *
 * 1. **不能在启动期注入服务。** `bootClient` 要求每个 Loader 入口都进入 active，
 *    而本插件的入口声明的是 `inject = []`；一旦改成注入 `slots`，入口会停在
 *    PENDING 并让整个 Web 启动失败。所以这里改为在运行时等待 `slots` 出现后
 *    再注册（轮询到服务就绪为止，注册成功即停止）。
 * 2. **不能拿到被框架绑定的 store / `t` 座位。** 那是给声明了 `hooks` 隔间的
 *    插件用的。这里用 React 自带的 `useSyncExternalStore` 读自己的外部快照源，
 *    文案直接写在组件里（本插件是面向中文界面的第三方插件，不参与 DSH 的
 *    字典与校验）。
 */
import { getSnapshot, loadPolicy, subscribe, updatePolicy } from './settings-store.js'

/** 分区在设置导航里的稳定 id。 */
export const SECTION_ID = 'session-trash'

/** 分区在设置导航里的标题，同时用作面板「设置」按钮的跳转锚点。 */
export const SECTION_LABEL = '会话删除'

/** 等待 `slots` 服务出现的轮询间隔与上限。 */
const ARM_INTERVAL_MS = 200
const ARM_TIMEOUT_MS = 30_000

/**
 * 模块表提供的 `require`。
 *
 * 浏览器半边与 DSH 内部 UI 插件一样，由模块表在物化时把 `require` 交给工厂。
 * 工厂形参只有工厂内部可见，而本模块是同一 bundle 里的另一个模块（esbuild 在
 * CJS 输出里会改写工厂局部标识符），因此构建包装器把 `require` 发布到
 * `globalThis.__dshSessionTrashRequire`，这里惰性读取。React 是平台内置模块，
 * 拿到的实例与宿主完全相同。
 * @returns {(specifier: string) => any} 模块表 `require`。
 */
function moduleRequire() {
  const requireFunction = globalThis.__dshSessionTrashRequire
  if (typeof requireFunction !== 'function') {
    throw new Error('session-trash: module-table require is not available')
  }
  return requireFunction
}

/**
 * 取 React 模块。
 * @returns {any} React。
 */
function useReact() {
  return moduleRequire()('react')
}

/** 防止 `moduleRequire` 被判为未使用（它只在运行时被调用）。 */
void moduleRequire

/**
 * 一个设置行：标题 + 说明 + 右侧控件。
 * @param {object} props 组件属性。
 * @returns {import('react').ReactElement} 行元素。
 */
function SettingRow({ title, hint, control }) {
  const React = useReact()
  return React.createElement('div', { className: 'dst-setting-row' },
    React.createElement('div', { className: 'dst-setting-text' },
      React.createElement('div', { className: 'dst-setting-title' }, title),
      React.createElement('div', { className: 'dst-setting-hint' }, hint),
    ),
    React.createElement('div', { className: 'dst-setting-control' }, control),
  )
}

/**
 * 开关控件。
 * @param {object} props 组件属性。
 * @returns {import('react').ReactElement} 开关元素。
 */
function Switch({ checked, disabled, onChange, label }) {
  const React = useReact()
  return React.createElement('label', { className: 'dst-switch' },
    React.createElement('input', {
      type: 'checkbox',
      checked,
      disabled,
      'aria-label': label,
      onChange: event => { onChange(event.target.checked) },
    }),
    React.createElement('span', { className: 'dst-switch-track' }),
    React.createElement('span', { className: 'dst-switch-thumb' }),
  )
}

/**
 * 「会话删除」设置分区。
 * @returns {import('react').ReactElement} 分区元素。
 */
export function SessionTrashSettingsSection() {
  const React = useReact()
  const { useSyncExternalStore, useEffect } = React
  const { policy, busy, error } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => { void loadPolicy() }, [])

  if (policy === null) {
    return React.createElement('div', { className: 'dst-setting-section' },
      React.createElement('div', { className: 'dst-setting-hint' },
        error === null ? '正在加载会话删除设置…' : `加载会话删除设置失败：${error}`),
    )
  }

  return React.createElement('div', { className: 'dst-setting-section' },
    error !== null && React.createElement('div', { className: 'dst-error' }, error),
    React.createElement(SettingRow, {
      title: '启用回收站',
      hint: '开启后，移入回收站的会话可以恢复。关闭后，该操作会在确认后永久删除会话。',
      control: React.createElement(Switch, {
        label: '启用回收站',
        checked: policy.useTrash !== false,
        disabled: busy,
        onChange: checked => { void updatePolicy({ useTrash: checked }) },
      }),
    }),
    React.createElement(SettingRow, {
      title: '保留天数',
      hint: '仅影响之后移入回收站的会话。设为 0 表示不限期保留；是否到期自动删除，由下方自动清理开关控制。',
      control: React.createElement(React.Fragment, null,
        React.createElement('input', {
        className: 'dst-number',
        type: 'number',
        min: 0,
        max: 3650,
        step: 1,
        'aria-label': '保留天数',
        defaultValue: String(typeof policy.keepDays === 'number' ? policy.keepDays : 30),
        disabled: busy,
        onBlur: event => {
          const parsed = Number.parseInt(event.target.value, 10)
          void updatePolicy({ keepDays: Number.isNaN(parsed) ? 30 : parsed })
        },
        onKeyDown: event => {
          if (event.key === 'Enter') event.target.blur()
        },
        }),
        React.createElement('span', { className: 'dst-number-unit', 'aria-hidden': true }, '天'),
      ),
    }),
    React.createElement(SettingRow, {
      title: '移入回收站前确认',
      hint: '开启后，每次移入回收站前显示确认提示，避免误操作。',
      control: React.createElement(Switch, {
        label: '移入回收站前确认',
        checked: policy.confirmDelete === true,
        disabled: busy,
        onChange: checked => { void updatePolicy({ confirmDelete: checked }) },
      }),
    }),
    React.createElement(SettingRow, {
      title: '回收站永久删除确认',
      hint: '清空回收站或在其中逐条永久删除时显示确认提示。会话菜单中的「彻底删除」始终需要确认。',
      control: React.createElement(Switch, {
        label: '回收站永久删除确认',
        checked: policy.confirmEmpty !== false,
        disabled: busy,
        onChange: checked => { void updatePolicy({ confirmEmpty: checked, confirmPurge: checked }) },
      }),
    }),
    React.createElement(SettingRow, {
      title: '自动清理过期会话',
      hint: '按保留天数自动永久删除过期会话。关闭后，需手动删除或清空回收站。',
      control: React.createElement(Switch, {
        label: '自动清理过期会话',
        checked: policy.autoPurge !== false,
        disabled: busy,
        onChange: checked => { void updatePolicy({ autoPurge: checked }) },
      }),
    }),
  )
}

/**
 * 等待 `slots` 服务出现，然后把设置分区注册进去。
 *
 * 轮询而不是 `ctx.inject(['slots'], …)`：本插件的入口声明 `inject = []`，
 * 目的是绝不因为等待服务而让 Web 启动失败；`ctx.inject` 会新建一个等待服务的
 * 子 fiber，把「入口是否 active」这件事交给框架的判断，风险不值得冒。
 * 轮询是纯粹被动的：服务没出现就什么都不做。
 * @param {any} ctx Cordis 客户端上下文。
 * @returns {() => void} 取消等待。
 */
export function armSettingsSection(ctx) {
  const disarmIcon = armSettingsNavIcon()
  const startedAt = Date.now()
  let timer
  let done = false
  let dispose = null

  /** @returns {void} */
  const attempt = () => {
    if (done) return
    const slots = ctx.get('slots')
    if (slots === undefined) {
      if (Date.now() - startedAt > ARM_TIMEOUT_MS) {
        timer = undefined
        return
      }
      timer = window.setTimeout(attempt, ARM_INTERVAL_MS)
      return
    }
    done = true
    timer = undefined
    // 分区注册用 `slots.inject`：等 `settings.section` 槽位被声明后再注册，
    // 槽位消失时自动摘除，生命周期跟随本插件 fiber。
    dispose = slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: SECTION_ID,
      // 排在「通用（0）/ 模型 / 插件」之后。
      order: 100,
      label: SECTION_LABEL,
    }, SessionTrashSettingsSection))
  }

  timer = window.setTimeout(attempt, ARM_INTERVAL_MS)
  return () => {
    done = true
    disarmIcon()
    if (timer !== undefined) window.clearTimeout(timer)
    if (typeof dispose === 'function') dispose()
  }
}

/**
 * 打开原生设置面板并定位到「会话删除」分区。
 *
 * Shell 把「当前打开的分区」当作组件内部状态，没有对外暴露打开或跳转的服务，
 * 因此这里走界面路径：点开侧边栏底部的设置触发器，再点导航里的分区项。
 *
 * **但两步不能露出两步的样子。** 面板带 CSS 过渡，直接「点开再点导航」会让用户先
 * 看到它带着默认分区（通用设置）淡入，然后才跳到「会话删除」。所以跳转期间给
 * `<html>` 挂一个 `dst-settings-jump` 类（样式表里把原生弹层整体 `visibility: hidden`），
 * 等目标分区真的成为当前分区、内容也渲染好了再摘掉——面板第一次出现时就已经停在
 * 目标分区上。见 `styles.js` 里的规则与说明。
 * @returns {Promise<boolean>} 是否成功跳转。
 */
export async function openTrashSettingsSection() {
  /** @param {number} timeoutMs 等待上限。 @returns {Promise<HTMLElement|null>} 目标元素。 */
  const waitFor = async (find, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = find()
      if (found !== null && found !== undefined) return found
      if (Date.now() > deadline) return null
      await new Promise(resolve => { window.setTimeout(resolve, 50) })
    }
  }

  // 已经打开过设置面板时，直接定位已有的导航项。
  /** @returns {HTMLElement|null} 目标分区导航项。 */
  const findNavCell = () => {
    for (const button of document.querySelectorAll('button')) {
      if (button.querySelector('span')?.textContent?.trim() === SECTION_LABEL) return button
    }
    return null
  }

  /**
   * 目标分区是否已经生效（当前分区 + 内容已渲染）。
   * @param {HTMLElement} cell 导航项。
   * @returns {boolean} 是否已就位。
   */
  const sectionReady = cell => cell.getAttribute('aria-current') === 'true'
    && document.querySelector('.dst-setting-section') !== null

  let navCell = findNavCell()
  if (navCell !== null) {
    // 面板已经开着，切换本来就在一帧内完成，不需要屏蔽。
    navCell.click()
    return true
  }

  /** @returns {HTMLElement|null} 触发器。 */
  const findTrigger = () => {
    for (const button of document.querySelectorAll('button[aria-haspopup="dialog"]')) {
      if (!(button instanceof HTMLElement)) continue
      if (button.closest('[data-dsh-session-trash]') !== null) continue
      return button
    }
    return null
  }
  const trigger = await waitFor(findTrigger, 3000)
  if (trigger === null) return false

  const root = document.documentElement
  root.classList.add('dst-settings-jump')
  try {
    trigger.click()
    navCell = await waitFor(findNavCell, 3000)
    if (navCell === null) return false
    navCell.click()
    const ready = await waitFor(() => (sectionReady(navCell) ? navCell : null), 3000)
    if (ready === null) return false
    // 让浏览器把「已就位」的这一帧画出来再放开屏蔽，避免放开后还要再跳一次。
    await new Promise(resolve => { window.requestAnimationFrame(() => { resolve() }) })
    return true
  } finally {
    root.classList.remove('dst-settings-jump')
  }
}

/** 宿主按分区 id 硬编码齿轮兜底；只标记本分区，使用 CSS 复用垃圾桶图形。 */
function armSettingsNavIcon() {
  const attribute = 'data-dst-settings-trash-icon'
  const scan = () => {
    for (const button of document.querySelectorAll('[role="dialog"] button')) {
      const isTarget = [...button.classList].some(name => name.endsWith('navCell'))
        && button.textContent?.trim() === SECTION_LABEL
      if (isTarget) button.setAttribute(attribute, '')
      else if (button.hasAttribute(attribute)) button.removeAttribute(attribute)
    }
  }
  const observer = new MutationObserver(scan)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  scan()
  return () => {
    observer.disconnect()
    for (const button of document.querySelectorAll('[' + attribute + ']')) button.removeAttribute(attribute)
  }
}
