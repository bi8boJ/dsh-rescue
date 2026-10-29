# Changelog

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

**安全**
- 所有写操作前先打前置快照；被覆盖的文件留 `.pre-<时间戳>` 副本
- 检测到 DSH 在运行就拒绝写（`--force` 可越过）
- 拒绝还原自身不完整或 `package.json` 非法的快照
- patch 只追加行，不重排 YAML；停用整层写 `[]` 而不是空文件

**测试**
- 132 个用例，跑在临时目录的合成 home 上
- 含 DSH 自带 `sanitizeProfile()` 洗劫后的场景重放：要求 bundles 顺序与 patch 内容逐字节还原
- `DSH_REAL_HOME=1` 时额外跑两个真实机器只读检查