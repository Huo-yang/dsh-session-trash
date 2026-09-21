# 架构与维护约定

[返回 README](../README.md)

## 运行边界

插件分成 Host 与浏览器两部分。`cordis.patch.yml` 注册一个插件包，该包通过 `dsh.client` 声明浏览器入口；不要为了浏览器代码再添加一个同名 Loader 行。

```text
会话菜单 / 回收站 / 原生设置
              ↓ 同源 HTTP
        /session-trash/*
              ↓
     Host handlers → store 写队列
              ↓
     回收站索引 / 会话目录 / 暂存目录
```

| 模块 | 职责 |
| --- | --- |
| `src/host/index.js` | 服务装配、业务处理器、工作区关联清理、定时任务 |
| `src/host/store.js` | 索引读写、路径定位、删除进度和恢复 |
| `src/host/routes.js` | HTTP 方法、请求体与响应封装 |
| `src/host/policy.js` | 默认策略与字段规整 |
| `src/client/index.js` | UI 装配、确认、删除前切换和删除后刷新 |
| `src/client/ghost-probe.js` | 单请求、单定时器的幽灵探测调度 |
| `src/client/ghost-sessions.js` | 连续缺失判定和待确认记录 |
| `src/client/row-identity.js` | 从行及分组的 React fiber 获取精确 ID |
| `src/client/row-filter.js` | 隐藏回收站、墓碑及幽灵条目 |
| `src/client/panel.js` | 回收站查看与操作 |
| `src/client/settings-section.js` | 原生设置分区注册和跳转 |

## 删除状态与恢复

软删除保留日志原位和工作区关联，但会先通过捕获的 `AgentHandle` 完整释放 live Agent/Session，并在回收站期间阻止同 ID 被 `create` 或 `resume`。恢复成功后才解除阻止；进程启动时从回收站索引重建阻止集合。永久删除按如下步骤执行：

1. 阻止同 ID 激活，完整释放 live Agent/Session，并核验两个 Registry 已清空。
2. 显式永久删除在同一个写队列槽中完成登记与清理，恢复不能插入两步之间。
3. 持久化原路径及 `deletionPhase: staged`，再搬入暂存目录。
4. 持久化 `deletionPhase: deleting`，再递归删除。
5. 删除成功后清理工作区关联，移除索引并落盘，再解除运行时阻止。

搬运失败直接报错，不回退为原地递归删除。批量操作逐条报告成功与失败；失败项保留。队列只覆盖当前 store 实例，不是跨进程文件锁。

恢复仅对日志仍在原位或可确认完整的暂存目录执行；目标已存在时不覆盖，路径越界、缺少可靠记录、日志丢失或物理删除已开始时保留索引并报错。`deleting` 是保守边界：即使剩余目录看起来完整，也不能据此保证恢复完整性。

工作区清理是尽力而为：缺少注册表或单个工作区清理失败会记日志，不撤销已完成的物理删除。

DSH 原生删除工作区只删除注册表记录，保留项目目录和会话日志。插件不监听该操作，也不会把它升级成会话批量删除。若回收站会话所属工作区已删除，恢复只恢复会话日志和可见性，不重建工作区，会话由 DSH 显示为未分组。旧索引中的 `trashDir` 只有在插件暂存根目录内且末级目录与编码后的会话 ID 一致时才允许递归删除。

## 请求语义

所有端点使用 `/session-trash` 前缀，响应为 `{ ok: true, value }` 或 `{ ok: false, error }`。业务拒绝可能使用 HTTP 200，客户端必须检查 `ok`。

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `state` | GET | 策略、回收站列表和隐藏 ID |
| `delete` | POST | `intent: trash` 软删除，`intent: permanent` 永久删除；省略默认软删除 |
| `restore` | POST | 安全恢复后移除索引 |
| `purge` | POST | 永久删除回收站中的单个条目 |
| `empty` | POST | 返回成功数量、成功 ID 与失败原因 |
| `sweep` | POST | 强制检查到期条目，忽略 `autoPurge` 开关 |
| `policy` | POST | 在队列内合并策略补丁 |
| `exists` | POST | 批量检查目录；`fresh: true` 绕过缓存 |
| `detach` / `reattach` | POST | 诊断用工作区关联操作 |

## 前端集成约束

- 菜单和工具栏没有所需的公开插槽，使用 DOM 注入。设置分区使用 `slots`。
- 客户端入口保持 `inject = []`，运行时等待服务；避免阻断 DSH 启动。
- 删除目标只能来自精确会话 ID，不能按标题、列表序号或浮层位置猜测。
- 不直接删除 React 管理的节点；菜单通过事件关闭。
- 幽灵探测需要两次缺失确认，复测强制读盘；退出列表的记录被清理，卸载后丢弃在途结果。
- 菜单识别含中文文案依赖，DOM / React 内部结构变化可能导致入口失效。

## 构建产物

`scripts/build.mjs` 生成 `lib/index.js` 与 `lib/client.js`。浏览器产物包装为 `window.__ModuleLoader__.load({ id, factory })`，显式返回 `apply` / `inject`。

React 由 DSH 模块表提供，必须保持 external，避免重复 React 实例破坏 hooks。构建产物不手工维护，也不纳入版本管理。
