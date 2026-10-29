# Changelog

## 0.4.0

**启动信标：不用再靠人记着按 good**

仓库里多了一个可选的小插件 `plugin/`（包名 `dsh-rescue-beacon`，约 100 行）：宿主 apply 时往 `<DSH_HOME>/rescue/beacon.json` 写 `booting`，60 秒后改写 `ok`，并记下当时的 bundle 列表哈希。

- `dsh-rescue good --auto`：只有信标说「这套配置确实起过且活过阈值」才标记，否则明确告诉你为什么不行（没装插件 / 还在 booting / 配置已经变了）
- `dsh-rescue status` 多一行「启动信标：成功启动 · 12 分钟前 · 配置与当前一致」
- 插件不该影响启动：所有写入都包在 try/catch 里，路径在调用时解析（`DSH_PROFILE_DIR` → cwd → `<DSH_HOME>/profiles/*`），临时文件 + rename 原子写
- 218 个用例（新增 beacon 11 个 + 命令层 5 个；其中一条专门断言 CLI 与插件的 `bundlesHash` 算法完全一致——否则信标永远对不上）

## 0.3.0

**二分定位：救回来之后，还得知道是谁干的**

- `dsh-rescue bisect`：把候选插件一半一半地加载、每轮自动启停一次 DSH、按"起得来/卡住"收缩嫌疑范围，最后报出元凶
- 先做两个对照：①现在这套应该起不来（否则没什么可二分）②只留基线 bundle 应该起得来（否则问题不在插件上，直接告诉你去 `crash` / `doctor`）
- 每轮结束杀进程（`killOnSuccess`），跑完一定把 `dsh.profile.bundles` 还原成你原来的样子，中途异常也一样（`finally`）
- `--round-timeout <秒>`（默认 60）、`--dry-run`、需要 `--yes`；DSH 开着时拒绝（它要反复启停）
- 202 个用例（新增 bisect 算法 8 个 + 命令层 5 个；命令层测试用"读取 fixture 里的 bundles 决定能否启动"的探针，等于真的在模拟二分）

## 0.2.0

**看门狗启动——覆盖"连对话框都没有"的卡死**

宿主的 `readyPromise` 没有超时，插件卡在 `apply()` 里时 Electron 会无限等：没窗口、没崩溃报告、没有可点的按钮。这一版让"从零启动"这件事本身受保护。

- `dsh-rescue launch`：启动 → 每秒探测"应用是否真的在 loopback 上监听" → 超时（默认 90 秒）就 `taskkill /T` 杀掉整棵进程树 → 回滚到最近 `good` → 再试一次 → 两次都失败就停下并给出下一步
- 就绪判定不靠猜：只有「图像名匹配 DSH 且监听 loopback 的端口」才算起来（实测健康实例是 `127.0.0.1:49862`）
- `--boot-timeout <秒>`、`--no-auto-restore`（只杀不救）、`--app <可执行文件>`
- 已有一个实例在跑时拒绝启动第二个；启动成功后 unref，关掉命令行不影响应用
- 189 个用例（新增 bootwatch / netprobe / launcher / app / launch-cli 五组，全部用注入替身，不真的启停应用）

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