# Changelog

## 0.1.1

**DSH NEXT 兼容（两个应用共用一份 profile 是"插件抢文件"的主因）**
- 运行时版本解析兼容两种 `app.asar` 布局（`dsh/` 前缀与根目录），新增 `--asar` 指定归档
- bundle 可以从安装包解析：NEXT 内置的 `dsh-community-market`、`@agents-anywhere/dsh-bridge-next` 不再被误报成"没装"
- 从 NEXT 写进 profile 的 `desktop-next.*.patch.json` 里自动反推它的安装位置
- 新增 `instances.dualHome`（主应用与 NEXT 同时运行）与 `profile.sharedWithNext`（profile 被 NEXT 共用）检查
- `rescue` 会提示这次还原会不会去掉 NEXT 写入的 `dsh.desktopNext*` 键
- 158 个用例

## 0.1.0

第一个可用版本。

**救援**
- `rescue`：把 profile 恢复到最近一次 `good`，先存坏现场，再报告「相对好状态多了什么」，最后重算哈希确认逐字节一致
- `restore <ref>`：还原任意快照（`last` / `good` / 完整 id / id 前缀）
- `safe-mode`：只保留 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`，依赖清单不动，可 `undo` 撤回
- `undo`：按 journal 里的前置快照撤回上一次写操作

**诊断**
- `status`：体检 + 最近崩溃 + 与 good 的差异
- `doctor`：静态体检（JSON/YAML 可解析、bundle 是否装了、依赖键与包名是否一致、patch 是否为空、版本闸门、豁免是否过期）
- `crash`：解析崩溃报告，抽出退出码、被跳过的 bundle、版本不兼容项、一直等不到服务的 entry
- `diff`：两个状态的结构化差异（bundle / 依赖 / patch / 文件）
- 运行时版本直接从安装目录的 `app.asar` 里读（`dsh-app-boot` 的清单，与 DSH 自己做闸门时同源），不依赖 PATH 上有 `dsh`；读不到才退化到调 CLI

**安全**
- 所有写操作前先打前置快照；被覆盖的文件留 `.pre-<时间戳>` 副本
- 检测到 DSH 在运行就拒绝写（`--force` 可越过）
- 拒绝还原自身不完整或 `package.json` 非法的快照
- patch 只追加行，不重排 YAML；停用整层写 `[]` 而不是空文件

**测试**
- 145 个用例，跑在临时目录的合成 home 上
- 含 DSH 自带 `sanitizeProfile()` 洗劫后的场景重放：要求 bundles 顺序与 patch 内容逐字节还原
- `DSH_REAL_HOME=1` 时额外跑两个真实机器只读检查