# 发布流程 / Release process

[中文 README](../README.md) · [English README](../README.en.md)

正式版本以 `package.json` 中的版本、`v<version>` Git 标签和 GitHub Release 为同一版本来源。发布准备分支使用 `release/<version>`，例如 `release/0.1.0`；发布完成后的修复进入新的修复版本，不重写已有标签或 Release 资产。

The version in `package.json`, the `v<version>` Git tag, and the GitHub Release must match. Prepare a release on `release/<version>`, such as `release/0.1.0`. Publish later fixes as a new patch version rather than replacing an existing tag or asset.

## 发布前 / Before release

1. 将 `CHANGELOG.md` 中待发布内容归入带日期的版本标题，并同步中英文 README。
2. 运行 `pnpm install --frozen-lockfile` 和 `pnpm run check`。
3. 运行 `pnpm run release:prepare -- v<version>`。该命令检查版本、打包文件范围，并在 `dist/` 生成 `.tgz`、`SHA256SUMS.txt` 和 `release-manifest.json`。
4. 在隔离的 DSH 数据目录和 profile 中从生成的 `.tgz` 安装，验证 Host 与 Web 插件加载、设置、软删除、恢复和永久删除。
5. 合并发布分支后，在目标提交创建并推送 `v<version>` 标签。

Update the changelog and READMEs, run the full check, build release assets with the matching tag argument, and install the generated archive into an isolated DSH profile. After the release branch is merged, create and push the matching tag on the intended commit.

## 自动发布 / Automation

推送 `v*` 标签会运行 Release workflow。工作流重新安装锁定依赖、执行完整检查、验证标签与包版本一致、生成校验和，并通过 GitHub CLI 创建 Release。手工触发只生成 Actions artifact，不创建 GitHub Release。

Pushing a `v*` tag runs the Release workflow. It installs locked dependencies, runs the full check, verifies tag/version consistency, creates checksums, and publishes a GitHub Release through GitHub CLI. Manual dispatch creates only a workflow artifact.

`dist/`、本地 profile、测试数据和安装记录属于本地产物，不进入 Git。`docs/images/` 中的实际界面截图随用户可见界面变化同步更新。
