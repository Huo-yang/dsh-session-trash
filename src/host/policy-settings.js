/**
 * 把删除策略接入 DSH 0.2 的插件配置表单。
 *
 * DSH settings 投影当前 Loader 条目的 Config，并把 `.volatile()` 字段作为可即时
 * 修改的用户设置。插件 Config 是唯一权威，旧索引 policy 只用于首次迁移，并继续
 * 作为降级兼容镜像。
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_POLICY, MAX_KEEP_DAYS, normalizePolicy } from './policy.js'

export const POLICY_NAMESPACE = 'session-trash'

export const Config = z.object({
  useTrash: z.boolean().default(DEFAULT_POLICY.useTrash).volatile(),
  keepDays: z.number().step(1).min(0).max(MAX_KEEP_DAYS).default(DEFAULT_POLICY.keepDays).volatile(),
  confirmDelete: z.boolean().default(DEFAULT_POLICY.confirmDelete).volatile(),
  confirmEmpty: z.boolean().default(DEFAULT_POLICY.confirmEmpty).volatile(),
  confirmPurge: z.boolean().default(DEFAULT_POLICY.confirmPurge).volatile(),
  autoPurge: z.boolean().default(DEFAULT_POLICY.autoPurge).volatile(),
})

/** @param {Record<string, any>} config DSH 校验后的插件配置。 */
function readConfig(config) {
  return normalizePolicy(Object.fromEntries(
    Object.keys(DEFAULT_POLICY).map(key => [key, config[key]?.get?.() ?? config[key] ?? DEFAULT_POLICY[key]]),
  ))
}

/**
 * 安装设置页呈现策略与旧配置迁移。
 * @param {any} ctx Cordis 上下文。
 * @param {ReturnType<import('./store.js').createTrashStore>} store 回收站存储。
 * @param {Record<string, any>} config DSH 校验后的插件配置。
 */
export function installPolicySettings(ctx, store, config) {
  /** @type {{settings: any, ready: Promise<void>}|undefined} */
  let active

  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'session-trash: settings presentation')
    const ready = (async () => {
      const descriptor = child.settings.describe().find(item => item.ns === POLICY_NAMESPACE)
      if (descriptor === undefined) throw new Error(`找不到插件配置项 ${POLICY_NAMESPACE}`)
      if (descriptor.user === undefined) {
        await child.settings.replace(POLICY_NAMESPACE, await store.readPolicy(), descriptor.revision)
      }
      await store.updatePolicy(readConfig(config))
    })().catch(error => {
      ctx.logger('session-trash').warn(`迁移删除策略到 DSH 设置失败：${messageOf(error)}`)
    })
    active = { settings: child.settings, ready }
    child.effect(() => () => {
      if (active?.settings === child.settings) active = undefined
    }, 'session-trash: policy settings')
  })

  return {
    async read() {
      const current = active
      if (current !== undefined) await current.ready
      const policy = readConfig(config)
      await store.updatePolicy(policy)
      return policy
    },
    async update(patch) {
      const current = active
      if (current === undefined) return store.updatePolicy(patch)
      await current.ready
      const descriptor = current.settings.describe().find(item => item.ns === POLICY_NAMESPACE)
      if (descriptor === undefined) throw new Error(`找不到插件配置项 ${POLICY_NAMESPACE}`)
      const next = normalizePolicy({ ...readConfig(config), ...(patch ?? {}) })
      await current.settings.replace(POLICY_NAMESPACE, next, descriptor.revision)
      await store.updatePolicy(next)
      return next
    },
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
