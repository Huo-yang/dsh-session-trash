/**
 * 浏览器半边的全部样式。
 *
 * 只使用主题暴露的 `--dsw-alias-*` 语义 token，因此外观自动跟随浅色/深色主题，
 * 不引入任何字面颜色。类名统一加 `dst-` 前缀，注入的节点都带
 * `data-dsh-session-trash` 标记，方便在 DevTools 里一眼认出是插件注入的。
 */

import { ICON_TRASH } from './ui.js'

const TRASH_MASK = `url("data:image/svg+xml,${encodeURIComponent(ICON_TRASH.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))}")`

/** 插件样式表文本；由 {@link injectStyles} 在插件加载时插入一次。 */
export const STYLES = `
[data-dst-settings-trash-icon] > svg { display: none !important; }
[data-dst-settings-trash-icon]::before {
  content: "";
  width: 16px;
  height: 16px;
  flex: none;
  background-color: currentColor;
  -webkit-mask: ${TRASH_MASK} center / contain no-repeat;
  mask: ${TRASH_MASK} center / contain no-repeat;
}

.dst-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dst-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dst-menu-item:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dst-menu-item-icon { display: inline-flex; width: 16px; height: 16px; flex: none; }
.dst-menu-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dst-toolbar-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dst-toolbar-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dst-toolbar-button[data-active="true"] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
/*
 * 「回收站里有会话」的状态点。
 *
 * 刻意不做成红色计数角标：红色在 DSH 里表示「有错误待处理」，而回收站本身会按
 * 保留期自动清理，常驻的红色数字会被读成待办事项。这里用主题的 success 主色
 * （绿）画一个小圆点，只表达「里面有东西」；数量放在按钮的 title / aria-label 里。
 * 位置贴着垃圾桶盖子右上角（按钮是 28px、图标 16px 居中，所以 2px 偏移刚好落在
 * 盖子上），再描一圈底色把点和图标的线条分开——否则绿点和桶身会糊在一起。
 */
.dst-toolbar-dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-base);
  pointer-events: none;
}
.dst-toolbar-wrap { position: relative; display: inline-flex; }

/*
 * 「跳到设置分区」期间的临时屏蔽。
 *
 * 设置面板没有对外的「打开到某个分区」接口（当前分区是 Shell 的组件内部状态），
 * 所以插件只能先点开面板、再点导航项。而面板本身带 CSS 过渡，于是用户会先看到它
 * 带着**默认分区**（通用设置）淡入，再跳到「会话删除」——一眼就能看出是两步。
 *
 * 这里在点开之前先把原生弹层藏起来（用 visibility 而不是 display：不改变布局，
 * 也就不影响随后的点击与过渡），等目标分区真的成了当前分区再放开。用户看到的就是
 * 面板直接出现在「会话删除」上。选择器只认原生弹层的**角色属性**，不认 CSS Module
 * 类名——那些哈希前缀随时会变。
 *
 * 两个角色都盖：presentation 是承载面板的遮罩，dialog[aria-modal] 是面板本身。
 * （注意：本文件是模板字符串，注释里不能出现反引号，否则会提前终止字符串。）
 */
html.dst-settings-jump [role="presentation"],
html.dst-settings-jump [role="dialog"][aria-modal="true"] {
  visibility: hidden !important;
}

/*
 * 动作条容器带 max-width:60px 与 overflow:hidden，正好只容纳原有的两个 28px
 * 按钮——第三个会被直接裁掉。容器属于 ui-workspace 的 CSS Module，类名带哈希
 * 前缀，用选择器去命中它太脆，所以放宽动作条宽度由 toolbar-button.js 以
 * 内联样式完成（并在卸载时还原），这里不写规则。
 */

.dst-mask {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-mask-1);
}
.dst-dialog {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(640px, 100%);
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  font-size: 14px;
}
.dst-dialog-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dst-dialog-title { flex: 1; min-width: 0; margin: 0; font-size: 15px; font-weight: 600; }
.dst-dialog-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px; }
.dst-dialog-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dst-dialog-footer-lead-group {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dst-dialog-actions { display: flex; align-items: center; gap: 8px; }

.dst-button {
  min-height: 32px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.dst-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dst-button:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; background: transparent; }
.dst-button-primary { background: var(--dsw-alias-button-contrast-fill); color: var(--dsw-alias-label-primary-foreground); }
.dst-button-primary:hover { opacity: 0.88; background: var(--dsw-alias-button-contrast-fill); }
.dst-button-danger { color: var(--dsw-alias-state-error-primary); }
.dst-button-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dst-button-ghost { border-color: var(--dsw-alias-border-l2); }

.dst-error {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
}
.dst-empty { padding: 28px 8px; color: var(--dsw-alias-label-tertiary); text-align: center; }

.dst-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dst-row:last-child { border-bottom: none; }
.dst-row-main { flex: 1; min-width: 0; }
.dst-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dst-row-meta {
  margin-top: 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dst-row-actions { display: flex; gap: 4px; flex: none; }

.dst-field { padding: 10px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dst-field:last-child { border-bottom: none; }
.dst-field-head { display: flex; align-items: center; gap: 10px; }
.dst-field-label { flex: 1; min-width: 0; }
.dst-field-title { display: block; }
.dst-field-hint { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }

/*
 * 「会话删除」原生设置分区。排版刻意对齐 DSH 自己的设置分区：
 * 每行 padding 16px 0 + 0.5px 分隔线，标题 14px/22px，说明用 caption 色。
 */
.dst-setting-section { display: flex; flex-direction: column; width: 100%; }
.dst-setting-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dst-setting-row:last-child { border-bottom: none; }
.dst-setting-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dst-setting-title { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dst-setting-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); }
.dst-setting-control { flex: none; display: flex; align-items: center; gap: 8px; }
.dst-setting-section .dst-error { margin: 12px 0 0; }

.dst-number-unit {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  white-space: nowrap;
}
.dst-number {
  width: 88px;
  min-height: 30px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
.dst-switch { position: relative; flex: none; width: 36px; height: 20px; }
.dst-switch input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
.dst-switch-track {
  display: block;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--dsw-alias-border-l4);
  transition: background 0.15s var(--ds-ease-in-out, ease);
  pointer-events: none;
}
.dst-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 8px;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 0.15s var(--ds-ease-in-out, ease);
  pointer-events: none;
}
.dst-switch input:checked ~ .dst-switch-track { background: var(--dsw-alias-state-success-primary); }
.dst-switch input:checked ~ .dst-switch-thumb { transform: translateX(16px); }

.dst-toast-host {
  position: fixed;
  left: 50%;
  bottom: 32px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transform: translateX(-50%);
  pointer-events: none;
}
.dst-toast {
  padding: 9px 14px;
  border-radius: 10px;
  background: var(--dsw-alias-toast-bg);
  color: var(--dsw-alias-label-primary-foreground);
  font-size: 13px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.24);
}
.dst-toast[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.dst-hidden-row { display: none !important; }
`

/** 样式标签的标识，避免重复注入。 */
const STYLE_ID = 'dsh-session-trash-styles'

/**
 * 把插件样式插入文档一次。
 * @returns {void}
 */
export function injectStyles() {
  if (document.querySelector(`style[data-dsh-plugin="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.dshPlugin = STYLE_ID
  tag.textContent = STYLES
  document.head.appendChild(tag)
}
