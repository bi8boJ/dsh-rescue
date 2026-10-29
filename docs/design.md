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

## 4. 写文件的硬规则

1. **先解析后写、写完再解析。** JSON 双向校验；YAML 只做行级操作。
2. **patch 只追加，绝不重排。** 禁用某个 entry 就是往文件末尾追加 `- id: <id>` + `disabled: true` 两行（宿主按 id 合并）。
   绝不 `safe_load` + `dump` 重写——注释、锚点、`!!js` 表达式、字段顺序都会丢。整层停用时写 `[]`，**绝不写空文件**。
3. **任何写入前先备份现场。** 被覆盖的文件同级留 `.pre-<时间戳>` 副本，`undo` 依据 journal 回滚。
4. **entry id 只认根级列表项。** `config:` 块里嵌套的 `- id: qwen3.8-flash` 是模型 id，不是插件条目——把它当条目会产生大量假警告（真实 profile 上实测过）。

## 5. 命令面

```
status    doctor    save    good    rescue
restore   safe-mode undo    list    diff    crash    menu
```

- `rescue` 没有 good 快照时的降级链：提示改用可逆的 `safe-mode` → 再用 `list` / `restore <id>` 逐个回退。永不静默删插件。
- 所有写操作都进 `journal.json`，`undo` 撤回上一次。

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

破坏矩阵覆盖：空 patch、纯注释 patch、非法 JSON、`bundles` 非数组、bundle 不在依赖且未安装、依赖键≠包名、patch 指向未知 id、`compatibility.json` 损坏、包目录缺失、快照自身不完整、快照里 package.json 是坏 JSON、DSH 正在运行、非 TTY 取消。

## 8. 阶段

- **v0.1**：本文全部命令 + 测试 + 中英 README
- **v0.2**：blame/bisect（半自动二分）、boot beacon（可选小插件，自动把"这次真的起来了"写进 good）、自动看门狗启动器