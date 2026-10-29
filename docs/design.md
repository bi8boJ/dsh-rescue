# dsh-rescue 设计

> DSH Desktop 因为插件互相冲突而**打不开**或**崩溃**时，以最小损失救回来。

## 1. 为什么不是插件

救援工具不能是 DSH 插件。DSH 打不开的时候，插件也跑不起来——救援通道必须在应用外面。

三条源码级事实决定了这个工具的形态（`app.asar` 内 `lib/main.js` 与 `dsh-app-boot/README.md`）：

1. **DSH 自带一半救援，但那一刀切是破坏性的。** 宿主致命崩溃时会弹原生对话框，第三个按钮「禁用第三方插件」调用 `sanitizeProfile()`：
   把 `cordis.patch.yml` 改名成 `.bak-<毫秒>`，然后把 `package.json` 的 `dsh.profile.bundles` **直接覆写**成出厂 web 模板。
   `.bak` 只保住了 patch 文件——**启用清单（哪些插件、什么顺序）没有任何备份**，被永久覆盖。这就是"救得回来，但恢复不到原样"的来源。
2. **真正的「打不开」它救不到。** `DesktopHostProcess.start()` 的 `readyPromise` 只等子进程发 `ready` 或退出，**没有任何超时**。
   插件在 `apply()` 里挂住（死循环、await 永不返回、等一个永远不会出现的服务）时，Electron 无限等待：没有窗口、没有崩溃报告、连恢复对话框都不会出现。
3. **空的 patch 文件比坏的更糟。** `dsh-app-boot` 明确写着「空或只有注释的文件会让启动失败——要停用这一层请写 `[]`」。任何"顺手清空"的操作都会把机器推向启动失败。

结论：核心是一条能在应用外面跑的命令，把 profile 恢复到「上一次确认可用」的那一套，并且先把坏现场完整存证。

## 2. 目标与非目标

**要**
- 一条命令回到上次可用：bundles 顺序、patch 内容、依赖版本清单全部逐字节还原
- 坏现场先存证，事后能看「相对上次好状态，到底多了什么」
- 静态体检，能在重启之前就发现大多数会让 DSH 起不来的配置问题

**不要（非目标）**
- 不启动、不守护 DSH 进程（自动看门狗是 v0.2 的事）
- 不碰 `node_modules` 的二进制内容、不装包（只报告缺失，给出命令，不代执行）
- 不碰 sessions / storages / workspace.json / 记忆库
- 不联网、不上报
- 不重排 YAML（见 §4）

**反目标**（做到就算失败）
- 把 patch 写成空文件
- 在 DSH 运行时写 profile（`dsh-hmr` 会当场热应用，可能把好状态一起弄坏）
- 还原后文件字节与快照不一致

## 3. 状态定义

一个快照 = 5 个配置文件 + 一份已装包清单：

| 文件 | 作用 | 缺省 |
|---|---|---|
| `profiles/<p>/package.json` | 依赖 + `dsh.profile.bundles`（谁被启用、什么顺序） | 必需 |
| `profiles/<p>/cordis.patch.yml` | 用户补丁层（配置覆盖、禁用行） | 可为空 |
| `profiles/<p>/compatibility.json` | 版本豁免 | 常有缺失 |
| `profiles/<p>/pnpm-workspace.yaml` | pnpm 设置（allowBuilds 等） | 可缺失 |
| `<dsh-home>/cordis.patch.yml` | 家目录级 patch，**优先级高于 profile 级** | 可缺失 |

外加 `installed.json`：遍历 `node_modules` 读每个包的 `name` + `version`，用来区分「规格没变但实际版本变了」。

不抓 `node_modules` 本体。**恢复配置 ≠ 重装包**；包缺失时明确报告并给出 `dsh plugin --profile <p> add <name>` 的提示，不代执行。

### 3.1 同一份 profile 有两个使用者

主应用和 DSH NEXT 共用一个 `~/.dsh/profiles/desktop`。实测证据：

- NEXT 往 `package.json` 里写 `dsh.desktopNextPlugins` / `desktopNextScheduleBundle` / `desktopNextOnboarding`
- NEXT 用 `desktop-next.cordis.patch.json`、`desktop-next.runtime.patch.json` 做 overlay（`cordis.yml` 里写明「the tree is composed as patches：bundles → cordis.patch.yml → --patch overlays」）
- NEXT 自带 `dsh-community-market@0.1.0-dev.0` 与 `@agents-anywhere/dsh-bridge-next@2.1.0-desktop…`，它们**不在** profile 的 `dependencies` 里，只在 app.asar 里
- 两边的 DSH 运行时其实是同一个：`0.2.1-rc.3`（NEXT 的版本号 `2.0.20-next` 是 Electron 应用版本，不是运行时版本）

由此三条设计约束：**bundle 解析要跨安装包**（否则 NEXT 内置的两个会被误报成"没装"）；**运行时版本解析兼容两种 asar 布局**（Desktop 有 `dsh/` 前缀、NEXT 没有）；**同时运行时必须警告并要求只留一个**（两个宿主 + 两套 HMR 会互相覆盖状态文件，这就是"插件抢文件"）。

## 4. 写文件的硬规则

1. **先解析后写、写完再解析。** JSON 双向校验；YAML 只做行级操作。
2. **patch 只追加，绝不重排。** 禁用某个 entry 就是往文件末尾追加 `- id: <id>` + `disabled: true` 两行（宿主按 id 合并）。
   绝不 `safe_load` + `dump` 重写——注释、锚点、`!!js` 表达式、字段顺序都会丢。整层停用时写 `[]`，**绝不写空文件**。
3. **任何写入前先备份现场。** 被覆盖的文件同级留 `.pre-<时间戳>` 副本，`undo` 依据 journal 回滚。
4. **entry id 只认根级列表项。** `config:` 块里嵌套的 `- id: qwen3.8-flash` 是模型 id，不是插件条目——把它当条目会产生大量假警告（真实 profile 上实测过）。

## 5. 命令面

```
launch    status    doctor    save    good    rescue
restore   safe-mode undo      list    diff    crash    menu
```

- `rescue` 没有 good 快照时的降级链：提示改用可逆的 `safe-mode` → 再用 `list` / `restore <id>` 逐个回退。永不静默删插件。
- 所有写操作都进 `journal.json`，`undo` 撤回上一次。

### 5.1 看门狗（launch）

`rescue` 依赖人发现"打不开了"，但宿主卡死时连对话框都没有。`launch` 把"启动"这件事本身纳入保护：

1. 启动应用（`--app` 或自动从 `resources/app.asar` 反推同目录的可执行文件）；
2. 每秒探测一次就绪：**`netstat -ano` 里存在"图像名匹配 DSH 且地址是 loopback 的 LISTENING 行"** 才算起来了（实测健康实例 = `127.0.0.1:49862`）。这条判据的好处是不需要知道端口号，也不用读 Electron 内部状态；
3. 超过 `--boot-timeout`（默认 90 秒）判定卡死 → `taskkill /PID <pid> /T /F` 杀整棵树（Electron 会派生宿主子进程，只杀父进程会留垃圾）→ 回滚到最近 `good` → 再启动一次；
4. 两次都失败就停，打印 `crash` / `doctor` / `safe-mode` 三条下一步，**不无限重试**。

刻意不做的：不判断"窗口是否出现"（不可靠且依赖平台），也不在检测到进程已退出时再 kill（已经没了）。所有副作用（spawn / probe / kill / sleep / now）都注入，所以状态机能在测试里完整跑一遍而不真的启停应用。

### 5.2 二分（bisect）

`launch` 把「这次能不能起来」变成机器可判定的布尔值，于是定位元凶可以自动化：

1. **两个对照**：确认当前整套起不来（否则没什么可二分）、确认只留基线 bundle 起得来（否则问题不在插件上，直接指向 `crash` / `doctor`）。
2. **二分**：把候选分成两半，"已经确认能起来的那半 + 这一半"一起加载；起来了说明元凶在没加载的那半，反之在加载的这半。4 个候选 2~3 轮。
3. **一定还原**：每轮改 `dsh.profile.bundles` 前都存快照，`finally` 里恢复原始值——中途抛异常也不会把你留在半残状态。

候选的定义是"在 `dependencies` 里且出现在 `bundles` 里"：出厂 bundle 与 `app.asar` 内置的（NEXT 的 `dsh-community-market` 等）属于基线，不参与二分，避免把应用自己的组件当嫌疑人。

## 6. 体检项

按"能否静态判定"排序：

- `package.json` 可解析；`bundles` 是字符串数组、无重复
- 每个 bundle 能在 `node_modules` 里解析到（出厂 bundle 跳过）
- 每个非出厂 bundle 都在 `dependencies` 里；依赖键 === 包实际 `name`（Desktop 有一致性校验，不一致会进恢复模式）
- `cordis.patch.yml` 可解析且**非空**（空文件单独高亮）
- patch 里的 id 在已启用 bundle 的补丁里找不到 → info（**前提是所有 bundle 的补丁都读得到**，否则跳过这项，避免对出厂 bundle 误报）
- `compatibility.json` 可解析；豁免的 `pkg@ver` 与当前实际版本对得上（插件升级后豁免失效）
- 版本闸门：有 `engines.dsh` 只看它，否则看 `peerDependencies` 里的 `@deepseek-ai/dsh*`
- 崩溃报告：`host exited with <code>`、`skipping profile bundle "x"`、`Plugin x@v is incompatible`、`N entry did not activate`、`pending (waiting for service: X)`

## 7. 测试

全部跑在临时目录的合成 home 上，绝不碰真实 `~/.dsh`。唯一例外是设置 `DSH_REAL_HOME=1` 才跑的两个只读检查：

- 真实 profile 只读体检，并用文件 stat 断言「一个字节都没改」
- 把真实 `package.json` / `cordis.patch.yml` 复制到临时 home，跑一遍 save → 破坏 → restore，断言逐字节还原

运行时版本不走子进程：直接按 asar 头（offset 12 是目录树 JSON 长度，payload 起点 16+长度再按 4 字节对齐）从 `app.asar` 里取 `dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json`，也就是 `getDshRuntimeVersion()` 读的同一份清单。CLI 只是退路，且 `.cmd` 必须经 `cmd.exe /d /s /c ""<path>" --version"` 才能启动。

破坏矩阵覆盖：空 patch、纯注释 patch、非法 JSON、`bundles` 非数组、bundle 不在依赖且未安装、依赖键≠包名、patch 指向未知 id、`compatibility.json` 损坏、包目录缺失、快照自身不完整、快照里 package.json 是坏 JSON、DSH 正在运行、非 TTY 取消。

## 8. 阶段

- **v0.1**：save / good / rescue / restore / safe-mode / undo / doctor / status / crash / diff + 测试 + 中英 README
- **v0.1.1**：DSH NEXT 兼容（两种 asar 布局、跨安装包解析 bundle、`instances.dualHome` / `profile.sharedWithNext`）
- **v0.2**：看门狗启动 `launch`（超时杀进程 + 回滚 + 重试一次），覆盖"宿主卡死、连对话框都没有"的场景
- **v0.3（未做）**：blame/bisect（半自动二分定位元凶）、boot beacon（可选小插件，把"这次真的起来了"写进 good）