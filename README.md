# dsh-rescue

DSH（DeepSeek Harness）被插件搞到**打不开**或者**崩溃**的时候，用一条命令把它救回来，而且不丢东西。

零依赖 Node CLI，跑在应用外面——因为 DSH 起不来的时候，任何装在 DSH 里面的东西也一起起不来。

```console
$ dsh-rescue rescue
将回到 20261029T101010123Z-9f3e（2 小时前标记为可用）
确认还原？会先把当前现场完整存一份。 [y/N] y
完成：已还原到 20261029T101010123Z-9f3e
写回    profiles/desktop/package.json, profiles/desktop/cordis.patch.yml
还原前现场 20261029T154130001Z-77ab
撤回    dsh-rescue restore 20261029T154130001Z-77ab

相对上次可用状态，坏掉时的现场是这样：
  新增 bundle：dsh-某个新插件
  依赖版本变化：dsh-better-sidebar ^0.28.0 → ^0.29.0
  patch 新增条目：llm-pi-ai
  以上差异已被撤销。

校验：当前配置与 good 逐字节一致 ✓
```

## 为什么需要它

DSH 自带一半救援，但那一半有两个洞（都能在 `app.asar` 里读到依据）：

**1. 自带的"禁用第三方插件"是不可逆的一刀切。**
宿主致命崩溃时会弹原生对话框，第三个按钮走 `sanitizeProfile()`：把 `cordis.patch.yml` 改名成 `.bak-<毫秒>` 备份，然后把 `package.json` 里的 `dsh.profile.bundles` **直接覆写成出厂模板**。
`.bak` 只保住了 patch 文件——**"我原本启用了哪些插件、什么顺序"这条信息没有任何备份**，被永久覆盖。你救回来了，但恢复不到原样。

**2. 真正的「打不开」它根本救不到。**
`DesktopHostProcess.start()` 的 `readyPromise` 只等子进程发 `ready` 或退出，**没有超时**。
插件在 `apply()` 里挂住（死循环、`await` 永不返回、等一个永远不会出现的服务）时，Electron 无限等待：**没有窗口、没有崩溃报告、连那个恢复对话框都不会出现**。你只能强杀、再启动、再挂。

**3. 空的 patch 文件比坏的更糟。**
`dsh-app-boot` 的文档写得很清楚：空或只有注释的 `cordis.patch.yml` 会让启动**直接失败**——要停用这一层必须写 `[]`。所以"顺手清空一下"是把自己往启动失败上推。

dsh-rescue 补的就是这三件事：**可逆、能覆盖挂死场景、绝不写空 patch。**

## 安装

需要 Node.js 20+。三种方式，任选：

```bash
# 直接从仓库用
git clone https://github.com/<you>/dsh-rescue.git
node dsh-rescue/bin/dsh-rescue.mjs status

# 或者全局装
npm install -g .

# Windows：双击 bin\dsh-rescue.cmd 就是交互菜单，
# 它会自己去找 PATH 上的 node，找不到就用 DSH 自带的那个。
```

> 装 DSH 的机器上 `node` 常常不在 PATH 上（DSH 自带运行时但没导出）。`bin/dsh-rescue.cmd` 与 `bin/dsh-rescue.sh` 会自动去常见位置找，也可以用 `DSH_RESCUE_NODE` 直接指定。

## 60 秒上手

```bash
# 1. DSH 正常的时候，先记一次"这个状态是好的"
dsh-rescue good

# 2. 哪天它起不来了（或者起来了但明显不对劲）
dsh-rescue status     # 体检 + 最近崩溃 + 跟上次好状态的差异
dsh-rescue rescue     # 一键回到上次可用，先存现场再还原

# 还没标记过 good？先用可逆的安全模式
dsh-rescue safe-mode  # 只留出厂 bundle，第三方全不加载
dsh-rescue undo       # 起来之后一次性撤回
```

`good` 之前建议先跑一次 `dsh-rescue doctor`；体检不过时 `good` 会拒绝（可以用 `--force` 强记，但那等于把坏状态当退路）。

## 命令

| 命令 | 作用 |
|---|---|
| `status` | 总览：静态体检 + 最近一次崩溃的事实 + 与上次可用状态的差异 |
| `doctor` | 只做静态体检，有错误时退出码 1（适合放进脚本/CI） |
| `good` | 把当前状态标记为"已知可用"（体检不过会拒绝） |
| `save` | 打一份普通快照（改插件前手动留档） |
| `rescue` | 一键救援：存现场 → 回到最近 good → 报告撤销了什么 → 校验逐字节一致 |
| `restore <ref>` | 还原任意快照；`ref` 支持 `last` / `good` / 完整 id / id 前缀 |
| `safe-mode` | 只保留 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，第三方全部不加载 |
| `undo` | 撤回上一次写操作（靠 journal 里的前置快照） |
| `list` | 快照列表，标出 good 指针 |
| `diff [a] [b]` | 两个状态的差异，默认 `good → 当前` |
| `crash` | 解析最近一次崩溃报告，抽出退出码、被跳过的 bundle、版本不兼容项、一直等不到服务的 entry |
| `menu` | 交互菜单（双击 `.cmd` 时默认走这里） |

通用选项：

```
--home <目录>       DSH_HOME，默认 $DSH_HOME 或 ~/.dsh
--profile <名字>    profile 名，默认 desktop
--runtime <版本>    直接指定 DSH 运行时版本（跳过探测）
--json              机器可读输出
--yes               跳过确认
--dry-run           只打印计划，不写任何文件
--force             DSH 在跑也照写 / 体检不过也标记 good
```

运行时版本会自动从安装目录的 `app.asar` 里读（和 DSH 自己做版本闸门时读的是同一份清单），所以不需要 `dsh` 在 PATH 上；真的读不到（比如装到了非常规位置）就用 `--runtime <版本>` 指定，否则版本闸门那一项会跳过。

## 它是怎么保证"不丢东西"的

- **写之前先存证。** 任何写操作都会先打一份前置快照（`pre-restore` / `pre-rescue` / `pre-undo` / `pre-safe-mode`），坏现场永远还在。
- **被覆盖的文件留副本。** 快照里不存在的文件若当前存在，是改名成 `.pre-<时间戳>` 而不是删除。
- **逐字节还原。** 还原后会自动重算哈希跟快照比对，不相等会明确告诉你。
- **运行中拒绝写。** 检测到 DSH 正在运行就拒绝（`dsh-hmr` 会当场热应用，可能把好的也弄坏）；确实要写加 `--force`。
- **快照自身坏了也不硬来。** 快照缺文件、或里面的 `package.json` 是坏 JSON 时，拒绝用它还原。

## 快照存在哪

```
<DSH_HOME>/rescue/
  snapshots/<id>/snapshot.json      元数据（bundles 清单、每个文件的哈希）
  snapshots/<id>/installed.json     当时装了哪些包、什么版本
  snapshots/<id>/files/...          5 个配置文件的原文
  good.json                         指向最近一次 good
  journal.json                      最近 50 次写操作
```

默认保留最近 30 个非 good 快照，good 永不被回收（`--retention` 可调）。配置文件都是几 KB，不用担心占地方。

## 它不做什么

- **不启动、不守护 DSH。** 自动看门狗（启动超时就杀 + 自动回滚）在 v0.2。
- **不动 `node_modules`。** 包真缺了只报告 + 给命令，不代装、不联网。
- **不碰会话、工作区、记忆库。** 只碰那 5 个插件配置文件。
- **不重排 YAML。** 只追加行，注释和 `!!js` 表达式原样保留。
- **不猜语义。** 某个 entry 已存在但没写 `disabled` 时，它不会替你改，而是告诉你手改。

## 平台

Windows 是实测平台（DSH Desktop 的主场）。macOS / Linux 的路径与崩溃日志目录都实现了，但**未在真机验证**——如果你在上面跑通了或者踩到坑，欢迎提 issue。

崩溃日志目录会同时看这两处：
- `%APPDATA%\@deepseek-ai\dsh-desktop\logs`（或 macOS/Linux 的等价位置）
- `<DSH_HOME>\electron-user-data\logs`（DSH NEXT 用的那套）

## 开发

```bash
node --test          # 145 个用例，全部跑在临时目录的合成 home 上
DSH_REAL_HOME=1 node --test test/real-smoke.test.mjs   # 额外跑两个真实机器只读检查
```

设计文档在 [docs/design.md](docs/design.md)。

## License

MIT