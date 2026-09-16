# 更新记录 / Changelog

## [Unreleased]

## [0.1.1] - 2026-09-16

### 修复 / Fixes

- 兼容 ACP 创建的裸 UUID 会话，使其正常显示“移入回收站”和“彻底删除”。
- 工作区分组展开时立即重新应用隐藏状态，避免回收站会话短暂闪现。

Support bare UUID session IDs created through ACP, and immediately reapply hidden state when expanding workspace groups to prevent trashed sessions from flashing briefly.

## [0.1.0] - 2026-09-16

### 功能 / Features

- 会话菜单删除、回收站面板、侧边栏状态点和原生设置分区。
- 保留时间配置、自动到期清理与精确会话 ID 过滤。

Session deletion controls, trash management, sidebar status, native settings, retention policies, expiration cleanup, and exact-ID filtering.

### 修复 / Fixes

- 删除失败保留索引，批量失败互不阻断，成功后清理工作区关联。
- 删除请求固定意图，防止策略变化把软删除升级为永久删除。
- 保存暂存位置及删除阶段，完整暂存可恢复；不完整或冲突状态不误报成功。
- 策略补丁在队列中合并，避免并发覆盖。
- 幽灵探测绕过旧缓存进行复核，并限制请求和定时器数量。
- 永久删除当前会话时先切走，成功后统一刷新列表。
- 限制旧版暂存路径的递归删除范围，拒绝越界路径。
- 将显式永久删除的登记和清理合并到同一个写队列操作，避免恢复插入后误报成功。
- 核实并覆盖 DSH 原生删除工作区后的恢复与永久删除行为。

Retained failed entries and isolated batch failures; fixed deletion intent, staged recovery, concurrent policy updates, ghost-probe scheduling, current-session switching, legacy staging-path containment, atomic permanent deletion, and native workspace-removal interaction.

### 工程 / Project

- 中文默认 README、英文 README、开发文档和 MIT 许可证。
- 默认隔离测试入口、文档链接检查、GitHub CI 和协作模板。

Chinese-default and English READMEs, development and release guides, MIT license, isolated test commands, package checks, CI and GitHub Release automation, and collaboration templates.
