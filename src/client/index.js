/**
 * dsh-session-trash 的浏览器半边。
 *
 * 四处 UI：
 * 1. 会话行「…」菜单里的「删除会话」（见 session-menu.js，DOM 注入）。
 * 2. 侧边栏动作条右侧的回收站入口与「里面有会话」状态点（见 toolbar-button.js，DOM 注入）。
 * 3. 回收站管理面板（见 panel.js，插件自有对话框）。
 * 4. 「会话删除」原生设置分区（见 settings-section.js，走 DSH 的 slots 扩展点）。
 *
 * 这是一个**不注入任何服务**的 Cordis 客户端插件：`bootClient` 要求每个 Loader
 * 入口都进入 active，所以入口不能因为等待服务而停在 PENDING。设置分区因此在
 * 运行时等待 `slots` 出现后自行注册。
 */
import { deleteSessions, probeSessions, readState } from './api.js'
import { listMissingSessions } from './ghost-sessions.js'
import { createGhostProbe } from './ghost-probe.js'
import { openTrashPanel } from './panel.js'
import { hideSession, listHiddenSessions, listPurgedSessions, rememberPurged, setHiddenEntries, sweep } from './row-filter.js'
import { readGroupIdentity, readRowIdentity } from './row-identity.js'
import { createSessionMenuExtension } from './session-menu.js'
import { armSettingsSection, openTrashSettingsSection } from './settings-section.js'
import { createToolbarButton } from './toolbar-button.js'
import { injectStyles } from './styles.js'
import { confirmDialog, toast } from './ui.js'

/** 无服务依赖：UI 挂载不等待任何 Cordis 服务。 */
export const inject = []

/** 监听 DOM 变化、刷新回收站状态的节流窗口。 */
const SWEEP_THROTTLE_MS = 300

/**
 * 插件入口。
 * @param {any} ctx Cordis 客户端上下文（本插件只使用其 logger）。
 * @returns {() => void} 卸载函数。
 */
export function apply(ctx) {
  injectStyles()

  const logger = ctx.logger?.('session-trash')
  /** 回收站当前条目数，供状态点与无障碍名使用。 */
  let count = 0

  const toolbar = createToolbarButton({
    onOpen: () => {
      openTrashPanel({
        onChanged: () => { void refresh() },
        onBeforePurge: sessionIds => beforePermanentDelete(sessionIds),
        onPurged: sessionIds => afterPermanentDelete(sessionIds),
        onRestored: () => refreshSessionList(),
      })
    },
  })

  const menu = createSessionMenuExtension({
    onTrash: identity => {
      void requestTrash(identity)
    },
    onPurge: identity => {
      void requestPurge(identity)
    },
  })

  /**
   * 让 DSH 重新拉一次「Host 权威的会话列表」。
   *
   * 彻底删除之后**必须**做这一步。DSH 的侧边栏是按「工作区分组 + 剩下没人认领的
   * 会话」拼出来的：会话日志一没、工作区条目一摘，它就从「属于某个工作区」变成了
   * 「没人认领」；而浏览器里缓存的列表还有它，于是它会以未分组的形式重新渲染。
   *
   * **但这一步常常不够。** 实测：如果被删的会话在客户端有常驻实例（也就是它被打开
   * 过），Host 会把移除推迟——`refresh()` 拉回来的权威列表里**仍然有它**，于是
   * 「未分组」分组照旧留着，而且会随着每次删除越堆越多，只有整页重新加载才干净。
   * 上游这条路我们改不了（DSH 自己没有删除功能，这条路径从没被走过），所以真正的
   * 兜底是下面那个「问 Host 日志还在不在」的幽灵探测。
   *
   * `sessions` 是 DSH 客户端服务（`reflect.provide('sessions', …)`），有公开的
   * `refresh()`。这里**不写进 `inject`**：入口一旦注入服务就会停在 PENDING，让
   * 整个 Web 启动失败。运行时用 `ctx.get` 现取；服务缺席（不同版本、headless
   * 客户端）时静默跳过。
   * @returns {Promise<boolean>} 是否真的调到了 DSH 的会话列表服务。
   */
  async function refreshSessionList() {
    try {
      const sessions = ctx.get('sessions')
      if (typeof sessions?.refresh !== 'function') {
        logger?.warn?.('没有找到会话列表服务（sessions），跳过列表刷新')
        return false
      }
      await sessions.refresh()
      return true
    } catch (error) {
      logger?.warn?.(error)
      return false
    }
  }

  const ghostProbe = createGhostProbe({
    getIds: () => ctx.get('sessions')?.list?.getSnapshot?.()?.ids ?? [],
    probe: probeSessions,
    onChanged: sweep,
    onError: error => logger?.warn?.(error),
  })
  const probeGhostSessions = ghostProbe.run

  /**
   * 如果被彻底删除的正好是**当前打开**的那条会话，先把界面切到最近的一条其它会话。
   *
   * 不切的话，删除之后当前选中项就成了一条已经不存在的会话：DSH 会把它判为失效，
   * 然后**自动新建一个空会话**顶上——用户刚做完「删掉这条会话」，看到的却是一片
   * 空白的新会话（这正是用户报的「强制刷新后页面定位到了一个新建的会话」）。先切
   * 到一条真实存在的会话，删除后停在一条正常的会话上，也不会平白多出一个空会话。
   *
   * 候选会话按 DSH 列表顺序（最近优先）取，且**跳过已经进回收站或已彻底删除的**：
   * 那些会话在界面上是隐藏的，切过去等于把用户从一个看不见的会话换到另一个。
   * 优先选同一个工作区（`cwd` 相同）的会话，把用户留在原来的分组里。
   *
   * 没有其它可用会话（列表里只剩这一条）时不做任何事，让 DSH 走它自己的兜底。
   * @param {string} sessionId 即将被彻底删除的会话 id。
   * @returns {Promise<string|null>} 切过去的会话 id；没切时为 `null`。
   */
  async function switchAwayIfCurrent(sessionId) {
    try {
      const sessions = ctx.get('sessions')
      if (typeof sessions?.list?.getSnapshot !== 'function' || typeof sessions?.open !== 'function') return null
      const snapshot = sessions.list.getSnapshot()
      if (snapshot?.current !== sessionId) return null
      // 候选必须是**真的还在**的会话：不能切到另一条已进回收站（界面上被隐藏）的
      // 会话上，否则等于把用户从一个看不见的会话换到另一个看不见的会话。
      const byId = snapshot.byId ?? {}
      const unavailable = new Set([...listHiddenSessions(), ...listPurgedSessions()])
      const usable = (snapshot.ids ?? []).filter(id => id !== sessionId && !unavailable.has(id))
      // 优先留在**同一个工作区**（`cwd` 相同）：删除当前会话不该顺手把用户甩到另一个
      // 工作区去——那会连侧边栏的分组展开状态、滚动位置一起换掉。
      const sameWorkspace = byId[sessionId]?.cwd
      const next = usable.find(id => byId[id]?.cwd === sameWorkspace) ?? usable[0]
      if (next === undefined) return null
      await sessions.open(next)
      return next
    } catch (error) {
      logger?.warn?.(error)
      return null
    }
  }

  /**
   * 彻底删除之后的统一收尾：立墓碑、刷新回收站状态、刷新 DSH 的会话列表。
   * @param {string[]} sessionIds 已被彻底删除的会话 id。
   * @returns {Promise<void>} 完成后 resolve。
   */
  async function afterPermanentDelete(sessionIds) {
    for (const sessionId of sessionIds) rememberPurged(sessionId)
    await refresh()
    await refreshSessionList()
  }

  /**
   * 彻底删除之前的准备：把当前打开的会话让开（见 `switchAwayIfCurrent`）。
   * @param {string[]} sessionIds 即将被彻底删除的会话 id。
   * @returns {Promise<void>} 完成后 resolve。
   */
  async function beforePermanentDelete(sessionIds) {
    for (const sessionId of sessionIds) await switchAwayIfCurrent(sessionId)
  }

  /**
   * 读取一次回收站状态与会话目录，同步状态点与列表隐藏集合。
   * @returns {Promise<void>} 完成后 resolve。
   */
  async function refresh() {
    try {
      const state = await readState()
      count = state.sessions.length
      setHiddenEntries(state.sessions)
      toolbar.setCount(count)
    } catch (error) {
      logger?.warn?.(error)
    }
  }

  /**
   * 把一个会话移入回收站。
   *
   * **默认不弹确认框。** 移入回收站是低风险、可恢复的操作，为它弹一次模态框是
   * 多余的摩擦；设置里的「移入回收站前确认」默认关闭，用户需要时才打开。
   *
   * 删除目标来自行的 React fiber（精确会话 id + 它在日志里的持久标题），
   * **不做任何按标题的反查**：DSH 对没有持久标题的会话显示的是工作区目录名，
   * 按标题匹配既会误伤同工作区的其它会话，也会把同名会话误判为「无法区分」。
   * 用户点了哪一行，删的就是哪一行。
   * @param {{sessionId: string, title: string}} identity 行的身份。
   * @returns {Promise<void>} 完成后 resolve。
   */
  async function requestTrash(identity) {
    const { sessionId, title } = identity
    const label = displayLabel(title, sessionId)
    let policy
    try {
      policy = (await readState()).policy
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
      return
    }
    // **暂存被关掉时，这一下就是不可恢复的落盘删除。** 策略能决定的是「要不要先
    // 放进回收站」，但用户点的是「移入回收站」——如果这时候不按「彻底删除」的
    // 规格确认，一次本以为是可恢复的点击会直接销毁日志。这个坑真的踩过：测试里
    // 遗留的 `useTrash: false` 让一次「移入回收站」变成落盘删除，丢了一条真实会话。
    const irreversible = policy.useTrash !== true
    if (irreversible || policy.confirmDelete === true) {
      const confirmed = await confirmDialog({
        title: irreversible ? '彻底删除会话' : '移入回收站',
        message: irreversible
          ? `回收站的暂存已关闭，这一步会永久删除「${label}」的会话日志，删除后无法恢复。`
          : `将把「${label}」移入会话回收站，之后可以在回收站里恢复。`,
        confirmLabel: irreversible ? '彻底删除' : '移入回收站',
        danger: irreversible,
      })
      if (!confirmed) return
    }
    try {
      // 两种删除都会释放 live 运行时；先切走当前会话，避免 DSH 在 disposal 后自动
      // 创建一条空会话，也避免界面继续持有已经进入回收站的当前实例。
      await beforePermanentDelete([sessionId])
      const result = await deleteSessions([{ sessionId, title }], irreversible ? 'permanent' : 'trash')
      // 暂存被关闭时 Host 会直接彻底删除，提示要跟着变，不能让用户以为还能恢复。
      if (result.mode === 'permanent') {
        await afterPermanentDelete([sessionId])
        toast(`已彻底删除会话「${label}」`)
      } else {
        hideSession(sessionId)
        toast(`已将「${label}」移入会话回收站`)
        await refresh()
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  /**
   * 彻底删除一个会话。
   *
   * **确认框不可关闭。** 这一步不可恢复、也不进回收站，任何设置都不应让一次
   * 误点直接落盘；`confirmPurge` 策略只作用于回收站面板里的同类按钮。用户显式
   * 选择的删除动作不该被策略静默降级，也不该被策略静默放行。
   * @param {{sessionId: string, title: string}} identity 行的身份。
   * @returns {Promise<void>} 完成后 resolve。
   */
  async function requestPurge(identity) {
    const { sessionId, title } = identity
    const label = displayLabel(title, sessionId)
    const confirmed = await confirmDialog({
      title: '彻底删除会话',
      message: `将永久删除「${label}」的会话日志，删除后无法恢复，也不会进入回收站。`,
      confirmLabel: '彻底删除',
    })
    if (!confirmed) return
    try {
      // 如果删的正好是当前打开的会话，先切到最近的一条其它会话：否则 DSH 会在
      // 当前选中项失效后自动新建一个空会话，用户看到的是一片空白。
      await beforePermanentDelete([sessionId])
      // 将确认过的永久删除意图传给 Host，策略变化不会改变这个动作。
      await deleteSessions([{ sessionId, title }], 'permanent')
      // **先立墓碑、刷新列表，再报结果。** 只把 id 从回收站里删掉是不够的：DSH
      // 缓存的会话列表还挂着它，而它已经不属于任何工作区分组，于是会被渲染到
      // 「未分组」下面（用户报的就是这个）；不重新拉列表就只能靠 DOM 硬藏。
      await afterPermanentDelete([sessionId])
      toast(`已彻底删除会话「${label}」`)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  /** 避免同一时刻重复拉取状态。 */
  let refreshInFlight = false
  /**
   * 带并发折叠的状态刷新。
   * @returns {Promise<void>} 完成后 resolve。
   */
  async function refreshPending() {
    if (refreshInFlight) return
    refreshInFlight = true
    try {
      await refresh()
    } finally {
      refreshInFlight = false
    }
  }

  /**
   * 每个 DOM 变更窗口最多刷新一次。
   * @returns {void}
   */
  const scheduleSync = createThrottled(() => {
    toolbar.ensure()
    sweep()
    void refreshPending()
    void probeGhostSessions()
  }, SWEEP_THROTTLE_MS)

  const observer = new MutationObserver(() => {
    // 展开工作区时 React 会重新插入会话行。隐藏集合已经在内存中，先同步应用它，
    // 才不会让回收站会话在下面那次 300ms 状态同步前短暂出现。
    sweep()
    scheduleSync()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  menu.observe()
  const disarmSettings = armSettingsSection(ctx)

  // 诊断句柄：便于在浏览器控制台或自动化测试里确认插件状态。
  globalThis.__dshSessionTrash = {
    get count() { return count },
    refresh: refreshPending,
    sweep,
    scanMenus: () => { menu.scan() },
    openPanel: () => {
      openTrashPanel({
        onChanged: () => { void refresh() },
        onBeforePurge: sessionIds => beforePermanentDelete(sessionIds),
        onPurged: sessionIds => afterPermanentDelete(sessionIds),
        onRestored: () => refreshSessionList(),
      })
    },
    openSettings: () => openTrashSettingsSection(),
    /** 当前隐藏集合与每行读到的身份（排查「该藏的没藏」时用）。 */
    inspect: () => ({
      hidden: listHiddenSessions(),
      purged: listPurgedSessions(),
      missing: listMissingSessions(),
      rows: [...document.querySelectorAll('[role="treeitem"]')]
        .filter(row => [...row.classList].some(name => name.endsWith('sessionRow')))
        .map(row => ({
          title: row.querySelector(':scope > span[class$="title"]')?.textContent?.trim() ?? '',
          identity: readRowIdentity(row),
          display: getComputedStyle(row).display,
          styleAttribute: row.getAttribute('style'),
        })),
      groups: [...document.querySelectorAll('[role="treeitem"]')]
        .filter(row => ![...row.classList].some(name => name.endsWith('sessionRow')))
        .map(row => ({
          group: readGroupIdentity(row),
          display: getComputedStyle(row).display,
        })),
    }),
    /** 诊断/自动化用：立刻做一次幽灵探测（问 Host 日志还在不在）。 */
    probeGhosts: () => probeGhostSessions(),
    forceHide: sessionId => { hideSession(sessionId) },
    /**
     * 诊断/自动化用：把一个会话按「已被彻底删除」处理（只影响界面，不碰数据）。
     *
     * 用于两种情况——排查「日志已经在别处被删掉了，界面还挂着这一行」，以及让
     * 自动化测试在不落盘删除任何东西的前提下复现「彻底删除后行掉进未分组区域」。
     */
    markPurged: sessionId => { rememberPurged(sessionId) },
    /**
     * 诊断/自动化用：立刻重新拉取 DSH 的会话列表（彻底删除之后的收尾动作）。
     *
     * 没有删除任何数据也能验证这段逻辑：先 `markPurged` 立墓碑、再用 Host 的
     * `detach` 摘掉工作区条目，界面就会复现「会话掉进未分组区域」；调用这里之后，
     * 那条会话应当从列表里彻底消失、连空的「未分组」分组一起消失。
     */
    refreshSessionList: () => refreshSessionList(),
    /**
     * 诊断/自动化用：如果参数是当前打开的会话，就切到最近的一条其它会话。
     * 只改「当前选中项」，不删任何数据、也不新建会话。
     */
    switchAwayIfCurrent: sessionId => switchAwayIfCurrent(sessionId),
    /** 当前会话列表状态（诊断用）：`{ ids, current, phase }`。 */
    sessionListState: () => {
      const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
      return snapshot === undefined ? null : { ids: [...(snapshot.ids ?? [])], current: snapshot.current ?? null }
    },
    /**
     * 一条会话在会话列表里的摘要（诊断用）。
     *
     * DSH 的侧边栏会对摘要做可见性过滤（`session.origin !== 'subagent'`、未归档、
     * 非 blank），所以排查「这条会话为什么不显示」时必须能读到原始摘要。
     */
    sessionSummary: sessionId => {
      const summary = ctx.get('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId]
      if (summary === undefined) return null
      return JSON.parse(JSON.stringify(summary, (key, value) => (typeof value === 'function' ? '[fn]' : value)))
    },
  }
  /** 本插件内部未捕获的异常记到这里，便于自动化测试与现场排查。 */
  globalThis.__dshSessionTrashErrors = []

  // 首次同步：应用主体可能还没挂载，MutationObserver 会在它出现后再跑一次。
  toolbar.ensure()
  void refreshPending()
  void probeGhostSessions()

  return () => {
    ghostProbe.dispose()
    observer.disconnect()
    menu.dispose()
    toolbar.dispose()
    disarmSettings()
  }
}

/**
 * 建立一个尾部节流的函数。
 * @param {() => void} action 动作。
 * @param {number} waitMs 节流窗口。
 * @returns {() => void} 节流后的函数。
 */
function createThrottled(action, waitMs) {
  /** @type {number|undefined} */
  let timer
  return () => {
    if (timer !== undefined) return
    timer = window.setTimeout(() => {
      timer = undefined
      action()
    }, waitMs)
  }
}

/**
 * 拼一个用于提示的会话名。没有持久标题的会话在界面上显示的是工作区目录名，
 * 这里退回名字或 id 前缀，只用于提示文案，不参与任何匹配。
 * @param {string} title 持久标题。
 * @param {string} sessionId 会话 id。
 * @returns {string} 显示名。
 */
function displayLabel(title, sessionId) {
  if (typeof title === 'string' && title !== '') return title
  const compactId = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return `会话 ${compactId.slice(0, 8)}`
}
