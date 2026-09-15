# 测试指南 / Testing

[中文 README](../README.md) · [English README](../README.en.md)

## 默认验证 / Default validation

```sh
pnpm run check
```

顺序执行文档链接检查、项目 TypeScript 检查、隔离测试和构建。仅使用已安装依赖；测试不访问真实 DSH。`checkJs=false`，不宣称完整 JavaScript 类型检查。

Runs documentation checks, the configured TypeScript check, isolated tests, and the build. Tests use installed dependencies and do not access live DSH data. Full JavaScript type checking is not enabled.

| 命令 / Command | 覆盖 / Coverage |
| --- | --- |
| `pnpm run test:handlers` | Fake store / workspace registry; endpoint behavior |
| `pnpm run test:store` | Temporary directories; deletion, recovery, path boundaries, concurrency, workspace-removal interaction |
| `pnpm run test:client` | Controlled timers and a simulated host; actual menu handlers and probe lifecycle |
| `pnpm run docs:check` | Local Markdown links and headings |

GitHub CI 配置使用 Node.js 24，在 Windows / Linux 上运行相同命令，不启动 DSH、不安装浏览器、不发布产物。远端执行结果以实际 Actions 记录为准。

CI is configured to run the same command with Node.js 24 on Windows and Linux. It does not start DSH, install browsers, or publish artifacts. Remote status depends on actual Actions runs.

发布包验证另见[发布流程](RELEASING.md)。Release archive validation is covered by the [release process](RELEASING.md).

## 真实实例测试 / Live-instance tests

这些脚本不是默认测试的一部分。它们会操作指定实例，必须使用独立的 `DSH_HOME` 和演示数据。profile 名称不同不等于数据隔离；运行 Host 与脚本时须使用同一个隔离数据目录。

These scripts operate on a running instance. Use a separate `DSH_HOME` with disposable data, shared by the test host and scripts. A separate profile name alone does not isolate session storage.

PowerShell 环境示例 / Environment example:

```powershell
# 在启动测试 Host 和运行脚本的终端中设置同一绝对路径：
# Set this same absolute path in both the host and test terminals:
$env:DSH_HOME = Join-Path (Get-Location).Path '.dsh-test'
```

在该环境中单独配置 DSH Web profile，准备演示会话。以下命令只供显式运行，不会由 CI 调用。

Configure a DSH Web profile and disposable sessions in that environment first. Commands below are manual and never invoked by CI.

```sh
node scripts/e2e.mjs --port 3082
node scripts/ui-test.mjs --port 3082 --url-token <token>
```

- `e2e.mjs` 会修改策略和回收站；默认跳过部分永久删除测试，但不能视为只读脚本。
- `ui-test.mjs` 会修改设置和会话状态；拦截 `purge`、`empty` 和永久删除意图。
- 两个浏览器脚本目前写死 Windows Edge 路径；非默认位置或非 Windows 系统需先调整，不能直接作为跨平台 UI 测试。

The API test modifies policy and trash state; it is not read-only. The UI test changes settings and session state while blocking permanent-delete requests. Browser scripts currently hard-code Windows Edge paths and need adaptation elsewhere.

下列命令会执行真实删除，仅用于一次性测试数据 / The following commands perform physical deletion and require disposable data:

```sh
node scripts/e2e.mjs --port 3082 --destructive
node scripts/ghost-test.mjs --port 3082 --url-token <token>
```

`--clean` 会额外处理历史测试条目，不用于个人真实数据目录。幽灵测试会创建并删除合成会话，且可能读取实例中的现有日志作为素材。

`--clean` additionally processes older test entries; do not use it with personal data. The ghost test creates and deletes synthetic sessions and may read existing logs as fixture material.

## 记录结果 / Recording results

报告 DSH / Node.js / 浏览器版本、使用的命令、是否为隔离目录及失败输出。不要上传访问令牌、真实日志或包含个人信息的路径。不能将本地通过等同于 GitHub Actions 或所有 DSH 版本通过。

Report versions, commands, isolation details, and failures. Exclude tokens, real logs, and personal paths. Local success does not establish remote CI or universal DSH compatibility.
