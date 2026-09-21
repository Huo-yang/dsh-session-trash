/**
 * 回收站管理面板。
 *
 * 面板是一个无框架的模态框，只做一件事：列出回收站条目，支持逐条恢复 /
 * 彻底删除、清空回收站。**删除策略不在这里**——它注册为 DSH 原生设置的一个
 * 分区（见 settings-section.js），面板的「设置」按钮只是打开原生设置并跳到
 * 该分区，不自己维护一套设置界面。
 *
 * 面板打开期间保持与 Host 的同步：每次操作后重新拉取状态；面板关闭即停止刷新。
 */
import { applyProbe } from './ghost-sessions.js'
import { emptyTrash, purgeSession, readState, restoreSession } from './api.js'
import { setHiddenEntries, unhideSession } from './row-filter.js'
import { openTrashSettingsSection } from './settings-section.js'
import { ICON_RESTORE, ICON_TRASH, confirmDialog, h, icon, openDialog, runOnce, toast } from './ui.js'

/** 面板刷新间隔：捕获别处（另一个标签页、定时清理）造成的回收站变化。 */
const REFRESH_INTERVAL_MS = 5000

/**
 * 打开回收站管理面板。
 * @param {object} [options] 依赖。
 * @param {() => void} [options.onChanged] 回收站内容变化后的通知（用于刷新按钮状态点）。
 * @param {(sessionIds: string[]) => Promise<void>} [options.onBeforePurge] 彻底删除之前的准备
 *   （如果删的是当前打开的会话，先切到别的会话，见 index.js 的 `switchAwayIfCurrent`）。
 * @param {(sessionIds: string[]) => Promise<void>} [options.onPurged] 彻底删除之后的收尾
 *   （立墓碑 + 刷新 DSH 的会话列表）。面板自己不碰这套逻辑：它需要插件入口持有的
 *   `ctx`，而面板只是个对话框。
 * @param {(sessionId: string) => Promise<void>} [options.onRestored] 恢复后刷新 DSH 会话列表。
 * @returns {void}
 */
export function openTrashPanel({ onChanged, onBeforePurge, onPurged, onRestored } = {}) {
  /** @type {{policy: object, sessions: object[]}|null} */
  let state = null
  /** @type {HTMLElement|null} */
  let listHost = null
  /** @type {number|undefined} */
  let timer

  const body = h('div')
  const dialog = openDialog({
    title: '会话回收站',
    body,
    onClose: () => { stop() },
  })

  /**
   * 停止后台刷新。
   * @returns {void}
   */
  function stop() {
    if (timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
  }

  /**
   * 拉取一次状态并重绘。
   * @returns {Promise<void>} 完成后 resolve。
   */
  async function refresh() {
    try {
      const next = await readState()
      state = { policy: next.policy, sessions: next.sessions }
      setHiddenEntries(next.sessions)
      render()
      onChanged?.()
    } catch (error) {
      renderError(error)
    }
  }

  /**
   * 渲染面板主体。
   * @returns {void}
   */
  function render() {
    if (state === null) return
    body.replaceChildren(renderList())
  }

  /**
   * @param {unknown} error 异常。
   * @returns {void}
   */
  function renderError(error) {
    body.replaceChildren(
      h('p', { class: 'dst-error', text: error instanceof Error ? error.message : String(error) }),
    )
  }

  /**
   * 渲染条目列表视图。
   * @returns {HTMLElement} 主体节点。
   */
  function renderList() {
    const sessions = state?.sessions ?? []
    listHost = h('div')
    if (sessions.length === 0) {
      listHost.appendChild(h('div', { class: 'dst-empty', text: '回收站是空的。' }))
    }
    for (const entry of sessions) listHost.appendChild(renderRow(entry))

    const footerLead = h('span', {
      text: `${String(sessions.length)} 个会话 · ${formatBytes(sessions.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0))}`,
    })
    const settingsButton = h('button', {
      class: 'dst-button dst-button-ghost',
      text: '设置',
      attrs: { type: 'button', title: '打开设置的「会话删除」分区' },
      onClick: () => {
        // 关掉自己的对话框，把用户交给原生设置面板。
        stop()
        dialog.close()
        void openTrashSettingsSection().then(opened => {
          if (!opened) toast('没有找到原生设置入口，请从侧边栏底部打开设置。', 'error')
        })
      },
    })
    const emptyButton = h('button', {
      class: 'dst-button dst-button-danger',
      text: '清空回收站',
      attrs: { type: 'button' },
      onClick: () => {
        runOnce(emptyButton, async () => {
          if (state?.policy.confirmEmpty === true) {
            const confirmed = await confirmDialog({
              title: '清空回收站',
              message: `将彻底删除 ${String(sessions.length)} 个会话，删除后无法恢复。`,
              confirmLabel: '彻底删除',
            })
            if (!confirmed) return
          }
          try {
            const ids = sessions.map(entry => entry.sessionId)
            await onBeforePurge?.(ids)
            const result = await emptyTrash()
            // 每一条都要立墓碑 + 刷新会话列表：清空之后回收站里什么都不剩，若不
            // 单独记住这些 id，下一轮整份刷新就会把它们忘掉，未分组区域会冒出一排
            // 已经删掉的行。
            await onPurged?.(result.purgedSessionIds)
            if (result.failed.length) {
              toast(`已删除 ${result.purged} 个会话，${result.failed.length} 个失败并保留在回收站：${result.failed.map(item => item.message).join('; ')}`, 'error')
            } else {
              toast(`已彻底删除 ${String(result.purged)} 个会话`)
            }
            await refresh()
          } catch (error) {
            toast(error instanceof Error ? error.message : String(error), 'error')
          }
        })
      },
    })
    emptyButton.disabled = sessions.length === 0
    dialog.setFooterLead([footerLead])
    dialog.setActions([settingsButton, emptyButton])
    return listHost
  }

  /**
   * 渲染一条回收站记录。
   * @param {object} entry 条目。
   * @returns {HTMLElement} 行节点。
   */
  function renderRow(entry) {
    const title = entry.title !== '' ? entry.title : `会话 ${entry.sessionId.slice(0, 18)}…`
    const restoreButton = h('button', {
      class: 'dst-button dst-button-ghost',
      attrs: { type: 'button', title: '恢复会话' },
      children: [icon(ICON_RESTORE, 'dst-menu-item-icon')],
    })
    restoreButton.addEventListener('click', () => {
      runOnce(restoreButton, async () => {
        try {
          await restoreSession(entry.sessionId)
          await onRestored?.(entry.sessionId)
          // Host 已确认日志回到原位，立即清除暂存期间的幽灵判定。
          applyProbe({ present: [entry.sessionId], missing: [] })
          unhideSession(entry.sessionId)
          toast(`已恢复会话「${title}」`)
          await refresh()
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), 'error')
        }
      })
    })
    const purgeButton = h('button', {
      class: 'dst-button dst-button-danger',
      attrs: { type: 'button', title: '彻底删除' },
      children: [icon(ICON_TRASH, 'dst-menu-item-icon')],
    })
    purgeButton.addEventListener('click', () => {
      runOnce(purgeButton, async () => {
        if (state?.policy.confirmPurge === true) {
          const confirmed = await confirmDialog({
            title: '彻底删除会话',
            message: `将永久删除「${title}」的会话日志，删除后无法恢复。`,
            confirmLabel: '彻底删除',
          })
          if (!confirmed) return
        }
        try {
          await onBeforePurge?.([entry.sessionId])
          await purgeSession(entry.sessionId)
          await onPurged?.([entry.sessionId])
          toast(`已彻底删除会话「${title}」`)
          await refresh()
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), 'error')
        }
      })
    })
    return h('div', {
      class: 'dst-row',
      children: [
        h('div', {
          class: 'dst-row-main',
          children: [
            h('div', { class: 'dst-row-title', text: title }),
            h('div', { class: 'dst-row-meta', text: describeEntry(entry) }),
          ],
        }),
        h('div', { class: 'dst-row-actions', children: [restoreButton, purgeButton] }),
      ],
    })
  }


  refresh().catch(() => {})
  timer = window.setInterval(() => { void refresh() }, REFRESH_INTERVAL_MS)
}

/**
 * 一行条目的说明文本。
 * @param {object} entry 条目。
 * @returns {string} 面向用户的说明。
 */
function describeEntry(entry) {
  const parts = []
  if (typeof entry.workspace === 'string' && entry.workspace !== '') parts.push(entry.workspace)
  parts.push(`删除于 ${formatTime(entry.deletedAt)}`)
  if (entry.expiresAt === null) parts.push('永久保留')
  else parts.push(`${formatTime(entry.expiresAt)} 到期`)
  if (typeof entry.sizeBytes === 'number' && entry.sizeBytes > 0) parts.push(formatBytes(entry.sizeBytes))
  if (entry.filesPresent === false) parts.push('文件已不在磁盘上')
  return parts.join(' · ')
}

/**
 * 格式化时间戳。
 * @param {number} timestamp 毫秒时间戳。
 * @returns {string} 本地时间文本。
 */
function formatTime(timestamp) {
  if (typeof timestamp !== 'number' || timestamp <= 0) return '未知时间'
  const date = new Date(timestamp)
  const pad = value => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 格式化字节数。
 * @param {number} bytes 字节数。
 * @returns {string} 文本。
 */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
