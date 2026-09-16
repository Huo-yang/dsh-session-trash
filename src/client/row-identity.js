/**
 * 从会话行的 DOM 上读出它的**精确身份**。
 *
 * DSH 的会话行不暴露 id 属性，但行节点上挂着 React 的内部 fiber，`fiber.memoizedProps.node`
 * 正是渲染这一行的 `SessionNode`（`{ id, title, blank, updatedAt, … }`）。这是唯一
 * 能拿到精确会话 id 的地方，也是本插件**唯一**用来把「用户点的那一行」映射回
 * 「真实会话」的依据。
 *
 * 为什么不做别的猜测：
 * - **不能按标题反查。** DSH 的行标题是 `displayTitle`，没有持久标题的会话显示
 *   的是**工作区目录名**（例如 `DSH_Plugin`）。同一个工作区里可能有多条这样的行，
 *   按标题匹配会一次隐藏/删除多条，而且同名会话还会被误判为「无法区分」。
 * - **不能按列表序号推断。** 侧边栏顺序受「最近更新」等设置与用户手工排序影响，
 *   与 Host 目录的顺序不是同一个东西。
 * - **不能按几何位置匹配。** 行高不一致时会选错相邻行。
 */

/** React 内部 props 在 DOM 节点上的键前缀。 */
const REACT_PROPERTY_PREFIXES = ['__reactFiber$', '__reactInternalInstance$']

/**
 * 会话 id 的两种已知形状，用于在 props 里辨认。
 *
 * DSH 自己的会话仓库会生成 `session-…`；ACP 的 `session/new` 则直接把
 * `randomUUID()` 的结果作为会话 id。这里明确接受这两类，避免把普通 props 字符串
 * 当成会话，同时保留对 DSH 测试仓库 `session-<n>` 的兼容。
 */
const PREFIXED_SESSION_ID_PATTERN = /^session-(?:\d+|[0-9a-f-]{8,})$/i
const UUID_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * 判断一个值是否是 DSH 已知的会话 id。
 * @param {unknown} value 候选值。
 * @returns {value is string} 是否为会话 id。
 */
export function isSessionId(value) {
  return typeof value === 'string'
    && (PREFIXED_SESSION_ID_PATTERN.test(value) || UUID_SESSION_ID_PATTERN.test(value))
}

/**
 * fiber `return` 链的扫描深度。
 *
 * 行节点到 `SessionNodeItem`（唯一带 `node` prop 的组件）之间夹着 `HoverCard`
 * 与若干 host 节点，实测约 12 层；留一倍余量，同时避免深挖到别的会话。
 */
const FIBER_DEPTH = 24

/**
 * 读出会话行的身份。
 * @param {Element|null} row 会话行（`[role="treeitem"]`）。
 * @returns {{sessionId: string, title: string, blank: boolean}|null} 身份；读不到时为 `null`。
 */
export function readRowIdentity(row) {
  if (!(row instanceof HTMLElement)) return null
  const node = readSessionNode(row)
  if (node === null) return null
  return {
    sessionId: node.sessionId,
    title: typeof node.title === 'string' ? node.title : '',
    blank: node.blank === true,
  }
}

/**
 * 读出**分组行**的身份。
 *
 * 分组行（工作区分组、以及那个「未分组」分组）的 fiber 上没有 `node`，但有
 * `props.group`：`{ key, workspaceId, cwd, label, sessionCount, expanded, containsCurrent, sessions }`。
 * 「未分组」那个分组的 `key` / `label` 是空串、`workspaceId` 是 undefined——它**只在
 * 有「没人认领」的会话时才会被渲染出来**，所以我们用它来判断「这个分组是不是只剩
 * 幽灵了」。
 * @param {Element|null} row 分组行（`[role="treeitem"]`）。
 * @returns {{key: string, workspaceId: string|undefined, label: string, sessionIds: string[]}|null} 分组身份。
 */
export function readGroupIdentity(row) {
  if (!(row instanceof HTMLElement)) return null
  for (const prefix of REACT_PROPERTY_PREFIXES) {
    const property = Object.keys(row).find(name => name.startsWith(prefix))
    if (property === undefined) continue
    let fiber = row[property]
    for (let depth = 0; depth < FIBER_DEPTH && fiber !== null && fiber !== undefined; depth += 1, fiber = fiber.return) {
      const group = fiber.memoizedProps?.group
      if (group === null || typeof group !== 'object') continue
      const sessionIds = (Array.isArray(group.sessions) ? group.sessions : [])
        .map(item => item?.sessionId ?? item?.id ?? item?.session?.sessionId ?? item?.session?.id)
        .filter(id => typeof id === 'string' && id !== '')
      return {
        key: typeof group.key === 'string' ? group.key : '',
        workspaceId: typeof group.workspaceId === 'string' ? group.workspaceId : undefined,
        label: typeof group.label === 'string' ? group.label : '',
        sessionIds,
      }
    }
  }
  return null
}
/**
 * 在行的 React fiber 链上寻找渲染这一行的 `SessionNode`。
 *
 * 只沿 `return` 链向上走有限层：`SessionNode` 由 `SessionNodeItem` 直接收到，
 * 通常就在第一两层内，深挖整棵树既慢又容易抓到别的会话。
 * @param {HTMLElement} row 会话行。
 * @returns {{sessionId: string, title?: string, blank?: boolean}|null} 会话节点。
 */
function readSessionNode(row) {
  for (const prefix of REACT_PROPERTY_PREFIXES) {
    const key = Object.keys(row).find(name => name.startsWith(prefix))
    if (key === undefined) continue
    let fiber = row[key]
    for (let depth = 0; depth < FIBER_DEPTH && fiber !== null && fiber !== undefined; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps
      if (props === null || typeof props !== 'object') continue
      const candidate = props.node ?? props.session ?? props.item
      const sessionId = candidate?.sessionId ?? candidate?.id
      if (isSessionId(sessionId)) {
        return { sessionId, title: candidate.title, blank: candidate.blank ?? props.blank }
      }
    }
  }
  return null
}
