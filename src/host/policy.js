/**
 * 删除策略：定义回收站的行为。每个字段都可以在设置页里改，改动持久化在回收站
 * 索引文件里，因此不需要重启 DSH。
 *
 * @typedef {object} DeletePolicy
 * @property {boolean} useTrash 是否先移入回收站。关闭表示「移入回收站」这个动作
 *   也会直接落盘删除（菜单里的「彻底删除」不受影响，它本来就直删）。
 * @property {number} keepDays 回收站保留天数，`0` 表示永久保留。到期条目在下次清点
 *   （`sweep`）时被彻底删除。
 * @property {boolean} confirmDelete 「移入回收站」前是否弹出确认框。默认关闭：这是
 *   低风险、可恢复的操作，弹模态框只是多余的摩擦。
 * @property {boolean} confirmEmpty 清空回收站前是否弹出确认框。
 * @property {boolean} confirmPurge 回收站面板里「彻底删除」单个条目时是否确认。
 *   会话行菜单里的「彻底删除」不受它影响——那一步始终确认（见 requestPurge）。
 * @property {boolean} autoPurge 是否自动清理到期条目（关闭后仍可手工清空）。
 */

/** 默认删除策略：暂存 30 天；移入回收站不打扰，破坏性操作要确认。 */
export const DEFAULT_POLICY = Object.freeze({
  useTrash: true,
  keepDays: 30,
  confirmDelete: false,
  confirmEmpty: true,
  confirmPurge: true,
  autoPurge: true,
})

/** 合法保留天数上限（10 年），避免设置页填出无意义的巨值。 */
export const MAX_KEEP_DAYS = 3650

/**
 * 把外部输入（HTTP 请求体、配置文件）规整成完整策略，非法字段回落到默认值。
 * @param {unknown} raw 待规整的候选策略。
 * @returns {typeof DEFAULT_POLICY} 完整且合法的策略。
 */
export function normalizePolicy(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    useTrash: readBoolean(source['useTrash'], DEFAULT_POLICY.useTrash),
    keepDays: readKeepDays(source['keepDays']),
    confirmDelete: readBoolean(source['confirmDelete'], DEFAULT_POLICY.confirmDelete),
    confirmEmpty: readBoolean(source['confirmEmpty'], DEFAULT_POLICY.confirmEmpty),
    confirmPurge: readBoolean(source['confirmPurge'], DEFAULT_POLICY.confirmPurge),
    autoPurge: readBoolean(source['autoPurge'], DEFAULT_POLICY.autoPurge),
  }
}

/**
 * @param {unknown} value 候选布尔值。
 * @param {boolean} fallback 非法时使用的默认值。
 * @returns {boolean} 规整后的布尔值。
 */
function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * @param {unknown} value 候选保留天数。
 * @returns {number} `0`（永久）到 {@link MAX_KEEP_DAYS} 之间的整数。
 */
function readKeepDays(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) return DEFAULT_POLICY.keepDays
  return Math.min(Math.trunc(parsed), MAX_KEEP_DAYS)
}
