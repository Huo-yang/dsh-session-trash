# 贡献指南 / Contributing

欢迎提交问题、文档改进和代码修改。使用说明见 [中文 README](README.md) / [English README](README.en.md)。

## 开发环境 / Development setup

使用 Node.js 24 和项目固定的 pnpm 版本。Use Node.js 24 and the pinned pnpm version.

```sh
pnpm install --frozen-lockfile
pnpm run check
```

不需要运行 DSH 即可执行默认测试。The default tests do not require a running DSH instance.

## 修改约定 / Change guidelines

- 保持修改聚焦；用户可见行为变化需要同步两份 README。
- 删除与恢复逻辑需要覆盖失败、并发和重试，优先使用合成数据。
- 不手工编辑 `lib/`；通过构建脚本生成。
- 不提交 `node_modules/`、访问令牌、真实会话日志或个人数据目录。
- 不增加未经验证的 DSH 兼容性声明；DOM / React 内部结构变化需独立验证。

Keep changes focused, update both READMEs for user-facing changes, and cover failure, concurrency, and retry behavior with synthetic data. Build `lib/` instead of editing it. Do not commit dependencies, tokens, real session logs, or personal data directories. Verify compatibility claims against DSH.

## 提交前验证 / Before submitting a change

```sh
pnpm run check
```

该命令包括文档链接检查、项目 TypeScript 检查、隔离测试及构建。当前 `checkJs=false`，TypeScript 检查不等于完整 JavaScript 类型验证。

This checks documentation links, runs the configured TypeScript check and isolated tests, then builds the plugin. `checkJs=false` means JavaScript is not fully type-checked.

真实实例测试见[测试指南](docs/TESTING.md)，不属于默认验证。Live-instance tests are separate from the default validation.

维护者发布步骤见[发布流程](docs/RELEASING.md)。Release preparation for maintainers is documented in the [release process](docs/RELEASING.md).

## Issue 与 Pull Request

Issue 请提供版本、复现步骤、预期和实际结果；截图及日志应先移除个人信息。PR 请解释问题、修改后的行为和验证结果。

Include versions, reproduction steps, expected behavior, and actual results in issues. Remove private information from screenshots and logs. PRs should explain the problem, the resulting behavior, and validation performed.

## 许可证 / License

提交贡献时，请确认你有权按项目的 [MIT 许可证](LICENSE)提供这些内容。

Make sure you have the right to contribute your changes under the project's [MIT license](LICENSE).
