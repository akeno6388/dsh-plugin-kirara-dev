# 架构与项目画像

## 代码结构

插件是**直接可加载的 ESM 源码**，没有构建步骤 —— DSH 的 loader 直接 `import()` 它。

```
dsh-plugin-kirara-dev/
├── package.json               # bundle 声明（dsh.bundle.patch）+ peerDependencies 契约
├── cordis.patch.yml           # insert 层，刻意不写任何与作者机器相关的字段
├── lib/                       # 宿主半边，四层（自更新见 docs/self-update.md）
│   ├── index.js               #   引导层：挂实现 + 自更新路由 + 热重载（很薄）
│   ├── impl.js                #   实现层：全部插件逻辑（11 个 kirara_* 工具 + PROJECTS/路由/构建）
│   ├── prompts.js             #   交接包的文字层：brief 九节 / prompt.md / 回执契约（纯函数，无 IO）
│   ├── update.js              #   自更新内核：查远端 / 下产物 / 解 tar.gz / 状态机 / 回滚
│   ├── client.js              #   浏览器半边：插件详情页里的徽标 / 按钮 / 更新区段
│   └── build-info.js          #   发版印章（随包这一份对应哪个提交，scripts/stamp.mjs 写）
├── locale/{zh,en}.json        # 插件在插件列表里显示的名称与描述
│                              #   （deploy.mjs 会逐字节比对这两个文件，漂移=列表显示旧文案）
├── scripts/                   # 开发期自检夹具，不进 profile
│   ├── selftest.mjs
│   ├── deploy.mjs
│   ├── mount-check.mjs
│   ├── contract-test.mjs
│   ├── handoff-test.mjs       # 外部交接：九节齐全 / 预算 / 回执校验 / 路径穿越 / runId 不覆盖
│   ├── doc-layer-test.mjs     # 分章文档层：发现 / map / search / section / 选章 / 插入计划 / 审计
│   ├── cache-budget.mjs       # 前缀缓存回归：工具目录逐字节稳定 + 返回值预算
│   ├── update-e2e.mjs         # 自更新端到端（离线假 GitHub + 真 cordis + 真引导层）
│   ├── update-live-check.mjs  # 自更新真实链路（联网打真 GitHub）
│   ├── client-panel-test.mjs  # 浏览器半边（详情页控件）无浏览器回归
│   ├── check-kernel-parity.mjs# lib/update.js 与另一个插件仓库是否逐字节一致
│   ├── stamp.mjs              # 发版前写 BUNDLED_SHA
│   └── host-interception.mjs
└── docs/
```

## 前缀缓存契约：改这个插件时最容易踩坏的东西

DSH 的请求按「最长相同前缀」复用 provider 缓存。插件能影响到的只有两条路径：

1. **工具目录抖动** —— `dsh-session` 把 `request/header`（`config` + `tools` 的 JSON 快照）记进会话；
   `dsh-agent-loop` 一旦发现装配出的工具集合与快照不等，就开一条新的 request series，
   而 `SystemPromptProjection.project()` 在开新 series 时是**原地改写对话第一条 system 消息**
   （`replace(head.seq, rendered)`），不是尾部追加 —— 整段前缀缓存作废。
   ⇒ 工具名 / `description` / `parameters` 必须是随启动固定的字面量，不含时间戳、文件状态、
   环境变量或任何运行时探测结果；也不在运行期增删工具。
2. **上下文膨胀** —— 返回值永久留在会话里；上下文越早触到 `dsh-compaction-basic` 的压缩阈值，
   就越早发生 compaction，而 compaction 同样会重写历史头部并再次触发上面的原地改写。
   ⇒ 每个工具的返回值都要过 `clampLine` / `budgetLines` / `clampText` 三道预算。

`scripts/cache-budget.mjs` 是这两条的机器化守卫，改 `description` 或任何输出预算后必跑。

进 profile 的是 `package.json`、整个 `lib/`、`cordis.patch.yml`，外加 npm 强制包含的 `README.md`
（见 `package.json` 的 `files` 数组）。`scripts/`、`docs/` 和 `node_modules/` 都不进 profile。

## `PROJECTS`：项目事实的唯一来源

`lib/impl.js` 顶部的 `PROJECTS` 数组是三端项目事实的唯一来源。各端构建方式、TFM、硬约束变化时
只改这里，不需要碰工具逻辑。

每一端的字段：

| 字段 | 含义 |
| --- | --- |
| `key` | 工具入参用的标识：`desktop` / `api` / `media` |
| `dir` | 仓库目录名，相对 `workspaceRoot` |
| `title` / `stack` / `tfm` | 显示用的名称、技术栈、目标框架 |
| `build` / `publish` / `run` | 命令与参数，`{ cmd, args }` |
| `specs` | 解决方案文件 |
| `docs` | 该端相关的技术文档路径（文件或**分章集目录**）。`kirara_start` 按这个列表推荐要读的文档，`kirara_docs` 从这个范围检索 —— 所以**只列真实存在**的路径 |
| `techDocs` | 该端的「技术栈主文档」：分章集目录（如 `docs/技术栈文档`）或单篇（如 `docs/服务端后端系统技术栈.md`）。`kirara_docsync` 的 `@tech` 规则与兜底都落在它上面 |
| `constraints` | 该端的硬约束，会随 `kirara_profile` 一起返回 |
| `ios` | **仅 media 有**：双端里 iOS 那一半的事实（`targets` / `versionLock` / `klibTasks` / `linkTasks` / 自检脚本 / 模拟器与 bundleId / 截图落点 / `pitfalls` / `docs`）。详见[media 的 iOS 半边](#media-的-ios-半边跨两台机器的一条链) |
| `apk` | 仅 media 有，构建产物路径，`kirara_build` 用它判断产物是否真的生成 |
| `release` | 该端的发布现实：版本号从哪读、是否递增、跑哪个脚本、产物怎么命名、有哪些前置条件、哪几篇 README 要过门禁。细节见[发布链路](#发布链路kirara_release--kirara_release_notes) |

三端的当前值：

| 端 | 目录 | 技术栈 | 目标框架 |
| --- | --- | --- | --- |
| desktop | `Kirara_Server_Studio` | WinUI 3 (Windows App SDK 2.3.1) + C# 13 + .NET 10 + CommunityToolkit.Mvvm 8.4 + LiteDB | `net10.0-windows10.0.19041.0` |
| api | `Kirara_Server-API` | ASP.NET Core 10 + Aspire 13.2.4 + PostgreSQL 16 / EF Core 10 + Redis + MinIO + SignalR | — |
| media | `Kirara_Media` | Kotlin Multiplatform + Compose Multiplatform 共享 UI（`:shared`）+ Koin；Android 壳 Jetpack Compose + Hilt + OkHttp + Coil，iOS 壳 SwiftUI + WKWebView | — |

### 内置命令里刻意绕开的坑

- **api 只构建 `Server` 单项目**：`Kirara_Server-API.Server` 会带出 Core / Infrastructure / Shared，
  实测 4.2 秒；整解 `Kirara_Server-API.slnx` 是 11 秒（还要算上 AppHost 与 `frontend.esproj`）。
  内建命令按「够用且更快」选单项目 —— 这是选择，不是绕坑。
  > **已修复的历史坑（2026-10）**：`Kirara_Server-API.slnx` 曾引用不存在的
  > `test-assets/DbCheck/DbCheck.csproj`，整解构建以 `MSB3202` 在 0.8 秒内失败，这也是当初
  > 改成单项目构建的起因。该悬空引用已删除（`kirara_server-api` 4db2275），整解现在可以构建成功；
  > 相应地把这条「绕坑」说明与 `PROJECTS.api.constraints` 里的悬空引用条目一并去掉了。
- **desktop 必须显式给平台**：`Kirara_Server_Studio.slnx` 只注册了 `x64`，命令里固定带 `-p:Platform=x64`。
  （2026-10-15 工程更名：`Kirara_Server-WinUI.slnx` / `.csproj` → `Kirara_Server_Studio.slnx` / `.csproj`，旧名已不存在。）
- **media 不跑单元测试**：按项目约定只用构建 + 实机/模拟器验证。
- **media 的命令按宿主机切**：Android 用 `gradlew.bat assembleDebug`，iOS 用
  `:shared:compileKotlinIos*` → `:shared:linkDebugFrameworkIos*` → `bash iosApp/run-simulator.sh`。
  `build` 字段只留 Android 那条（它是可发版主线）；iOS 那几条在 `ios.klibTasks` / `ios.linkTasks` /
  `ios.script` 里，由 `gradleInvocation()` / `iosPlan()` 按 `process.platform` 组装 ——
  **不把 mac 命令写进 Windows 的 `build`**，否则 `kirara_build` 会在 Windows 上 ENOENT。

### media 的 iOS 半边：一条跨两台机器的链

这是本插件里唯一**不是单机流程**的一段，所以它的事实全部集中在 `PROJECTS.media.ios`，
而不是散进各个工具：

| 步骤 | 命令 | 能在哪跑 |
| --- | --- | --- |
| klib 门禁 | `:shared:compileKotlinIosArm64 :shared:compileKotlinIosSimulatorArm64` | Windows / macOS 都行 |
| 链接 framework | `:shared:linkDebugFrameworkIosSimulatorArm64 :shared:linkDebugFrameworkIosArm64` | 仅 macOS |
| 模拟器自检 + 截图 | `bash iosApp/run-simulator.sh`（`KIRARA_IOS_SELFTEST=1` 等环境变量） | 仅 macOS |

三条设计决定：

1. **不新增工具，只在 `kirara_build` 上加 `target`。** 工具目录是前缀缓存的一部分，加一个工具
   要付一次「整段前缀作废」的代价；而「跑 iOS 的哪一段」本来就是一个命令的变体。
2. **不能跑的目标不假装跑过。** Windows 上 `target=ios` 会退化成 klib 门禁，把 mac 命令放进
   `macCommands`，`note` 里写明原因 —— 谎报一次「iOS 构建成功」比报错贵得多。
3. **`target=ios` 的产出直接接进 `kirara_verify`。** 脚本自己截图，`execute` 收集
   `iosApp/.tmp/ios-evidence/*.png` 放进 `screenshots`，于是 UI 改动那条「截图 → 视觉复核 →
   按 P0/P1 改 → 重截」的环在 Mac 上是**闭合**的（Windows 上则明确要求交接给 Mac）。

`ios.pitfalls` 是「静默失败」的坑（Xcode 不读 `~/.zshrc`、`doInitKoinIos()`、
`simctl` 不能打字、`setCookie` 必须等回调…）。它们**不写进 tool description**（那是常驻前缀），
只在 `kirara_verify` 的 iOS 清单里挑最相关的几条出现，完整清单永远指向
`Kirara_Media/app/docs/Kirara Media iOS P0 Mac 执行清单.md`。

## `SAFETY_RULES`：进程清理红线

`SAFETY_RULES` 会随 `kirara_profile` / `kirara_start` 一起返回，内容是：

- 禁止按进程名批量杀 `dotnet.exe` —— VS Code 的 C# Dev Kit 依赖它（CPS 宿主 + MSBuild 节点），
  误杀会导致语言服务反复重建、VS Code 内存飙升
- 禁止 `dotnet build-server shutdown` —— 会关闭 VS Code 正在复用的 MSBuild 节点，
  触发 C# 扩展全项目重载
- 只停止自己启动的进程（端口 → PID → 进程树），或直接 kill 对应的终端会话
- `gradlew --stop` 只影响 Gradle，安全

插件自己不执行任何进程清理，这些规则是给模型看的提示。

## 路由判定

`routeRequest()` 把一句话需求映射成「涉及哪几端 + 要不要实机验证 + 有没有阻塞项」。

### 端识别

`ROUTE_SIGNALS` 是一组「正则 → 端」的映射，可解释、可扩展，不做黑盒猜测：

| 端 | 命中关键词（节选） |
| --- | --- |
| desktop | `winui` / 桌面 / 客户端 / 方案 / 令牌 / 实例 / `webview2` / `rdp` / `openvpn` / `jellyfin` / 界面 / `xaml` / 首页 / 评论 / 任务栏 / 托盘 |
| api | `api` / 接口 / 服务端 / 后端 / 数据库 / `postgres` / `controller` / `signalr` / `minio` / `redis` / `aspire` / 迁移 / `sql` / `jwt` / 鉴权 |
| media | `android` / 安卓 / 手机 / `apk` / `compose` / `kotlin` / `gradle` / **`ios` / iphone / ipad / xcode / swiftui / simctl / wkwebview / 模拟器 / 双端** |

media 是双端，Android 与 iOS **共用同一个 `key`**（同一批 `:shared` 代码、同一批文档），
平台差异不拆成两个「端」，而是由 `kirara_build` 的 `target` 收口。
`IOS_SIGNALS` 单独抽成一个常量，被路由、文档选择、验证清单三处共用 ——
否则会出现「路由说是 iOS、验证清单却给 Android 的 adb 步骤」这种自相矛盾。

### 升级为 `full` 的信号

`mode=auto` 只要命中下面任一条，就不允许降级成 `small`：

| 常量 | 覆盖 | 举例 |
| --- | --- | --- |
| `UI_HINTS` | 外观 / 视觉词 | 界面、渲染、布局、样式、配色、暗色、字体、图标、动画、开关、弹窗、按钮、菜单、`xaml`、`theme` |
| `INTERACTION_SIGNALS` | 社交 / 交互功能词族 | `@`、提醒、通知、提及、评论、回复、点赞、收藏、分享、私信、聊天、消息、关注、订阅、推送 |
| `ROUTE_SIGNALS[].ui` | 某端专属的交互词 | `desktop.ui` = 评论 / 首页 / 界面 / `xaml` / 托盘 / 任务栏；`media.ui` = `IOS_SIGNALS`（iOS 的效果只能看模拟器截图，与界面词同权） |
| `DESTRUCTIVE_SIGNALS` | 破坏性 / 不可逆操作 | 破坏性、删除、移除、下线、停用、重命名、重构、重写、替换、更换、回滚、架构调整 |

数据库结构变更要求**两个词同时出现**，也就是 `DB_ACTION ∧ DB_OBJECT`：

- `DB_ACTION`：迁移、`migration`、改表、加表、建表、删表、加列、删列、改列、加索引、建索引、`schema`、`ddl`
- `DB_OBJECT`：表、库、`sql`、字段、列、索引、实体、`entity`、`ef`、`upgrade_v`

两个词表都刻意不含泛词。`DESTRUCTIVE_SIGNALS` 不含「迁移」，因为那个词归 `DB_ACTION` 管；
`DB_OBJECT` 不含「数据」，因为「把数据迁移到新服务器」不该被判成表结构变更。

### 为什么要有 `INTERACTION_SIGNALS`

纯外观词表永远补不全。发「评论支持 @ 提醒」这类需求时，请求里没有任何一个外观词，
早期版本会判成 `small`（构建成功即完成）。但 @ 提醒的正文就是评论框里的 `@` 选择器，
构建通过显然不等于提醒链路正确 —— 服务端通知、多用户 @、权限都是运行期事实。

误判的代价不对称，所以这张词表刻意宁滥勿缺。

### 纯文档变更（`mode=docs`）

真值表（A=文档对象、B=文档动作、C=文档结构词、D=代码对象）：

```
docsOnly = A ∧ (B ∨ C) ∧ (¬D ∨ C)
```

| 常量 | 覆盖 |
| --- | --- |
| `DOC_TARGET`（A） | 文档、README、`.md`、markdown、changelog、更新记录 |
| `DOC_ACTION`（B） | 更新、同步、补充、编写、撰写、修订、整理、校对、完善、追加、翻译、归档 |
| `DOC_STRUCTURE`（C） | 章节、段落、目录、条目、措辞、文案、标题、说明、描述、表格、示例、链接、错别字、排版、正文、注释 |
| `DOC_CODE_OBJECT`（D） | 功能、页面、接口、端点、组件、按钮、逻辑、方法、函数、类、表结构、字段、索引、上传、下载、控件 |

为什么是四项而不是一张词表：

- 只看 A 会把「**新增文档上传功能**」判成写文档；
- `B` 里刻意没有 新增 / 修改 / 重构 / 实现 —— 它们是代码动作，进来就会让「新增文档预览页面」免构建；
- `C` 的存在说明句子在谈**文档里的某段文字**：「更新 API 完整文档里的评论接口章节」虽然命中 D 的
  「接口」，但同时有 C 的「章节」⇒ 接口是被描述的对象，不是要改的代码；
- 「修改文档上传逻辑」既无 B 也无 C ⇒ 按代码需求处理。

命中即**短路**：破坏性、表结构、实机验证三类决策对一篇 md 全都不适用。判定偏保守
（漏判只是多跑一次编译，误判会让人以为「构建都免了所以没问题」），
没有端信号时退化成「三端都要看」，交给 `kirara_docsync` 收口。

### 空请求

`request` 为空时不猜，直接返回 `blocked: true` 和一条追问性质的 `decisions`，让调用方先问清楚。

## 分章文档层（2026-11）

### 为什么单独一层

2026-11 起技术栈文档从「一篇 258 KB 的 md」改成 `docs/技术栈文档/NN-标题.md` 分章集。
这不是排版偏好：单文件整篇读会挤爆上下文，只做关键词 grep 又会丢失「命中行属于哪个模块/小节」。
分章集要回答三个问题，而这三个都不是纯文本搜索能给的：

1. 这本书有哪几章、每章有哪些节、每节的稳定锚点是什么？
2. 本次改动的源文件对应哪一章（而不是靠关键词猜）？
3. 新内容应该插到哪一章、哪一节、第几行？

`lib/impl.js` 里的「分章文档层」就是这三个问题的实现。它不新增工具（工具目录是前缀缓存的一部分，
加一个工具要付一次整段前缀作废的代价），而是给 `kirara_docs` 加 `mode`，给 `kirara_docsync` 加章节计划。

### 发现规则（不写死路径）

`collectProjectDescriptors(base, p)`：

- 扫项目的 `docs/` 与 `app/docs/`，最多 2 层；
- 某目录同时有 **≥2 个 `NN-标题.md`（01–89）** ⇒ 一个分章集；
- `99-变更记录/` 是流水卷目录，不参与模块章判定；其文件作为 `changelog`；
- `_` 开头的文件是规范/临时文件，不参与正文检索；`README.md` 作为入口元信息；
- `PROJECTS.docs` 里登记的目录也按同一规则展开。

因此新增章节、拆分模块、换项目都不需要改插件；只要目录符合[写作规范](doc-conventions.md)。
单篇文档（API 完整文档、media 旧技术栈文档）仍按文件级处理，两种形态可以共存。

### 索引与缓存

`getProjectDocs(base, p)` 把每个文件解析成：

```js
{
  num, chapterTitle, module, level,
  frontmatterFiles, related,
  hasFrontmatter, isChangelog, isAppendix,
  sections: [{ num, title, line, endLine, anchor, subheadings }],
  anchors, anchorSet, links, lines
}
```

- frontmatter 用极简 YAML 解析（key: value / 行内数组 / 缩进 `-` 列表），不引入 YAML 依赖；
- `## NN.M` 解析后把编号从 `title` 剥掉，展示层统一拼 `${num} ${title}`，避免「03.1 03.1」；
- 锚点在标题**前后 2 行内**关联（兼容 `anchor` 在标题前、空行、标题后三种现有写法）；
- 索引按「路径 + mtime + size」失效：改完 md 下一次调用立刻看到新结构，不用重启；
- 每个进程一份缓存，不落盘 —— 文档结构是仓库事实，缓存只是省重复 IO。

### `kirara_docs` 的三种模式

| 模式 | 数据 | 渲染 |
| --- | --- | --- |
| `map` | 每个分章集的 `chapters`（含 sections/anchors）+ changelog 摘要 + 单篇文档 + `warnings` | 章标题 + 前 3 个小节；`chapter` 参数展开该章全部小节与行号；末尾结构审计 |
| `search` | 命中行 + `chapter` / `section` / `anchor`；按章标题、小节标题、frontmatter.files、正文加权；99 降权 | `文件:行号 [章 › 节] #anchor` + 该行 |
| `section` | 按 `NN.M`、`#anchor`、标题片段找唯一小节；返回正文（上限 `docsBudget - 300`） | 标题 + 行范围 + 锚点 + 正文 |

`search` 的加权顺序是刻意的：命中章标题/小节标题、或命中 `frontmatter.files` 里的文件，
比命中正文更可能是「该读这一节」；`99` 是历史证据，减权后仍可按需检索，但不会淹没稳定结论。
`map` / `search` / `section` 共用 `docsBudgetChars`，超预算时提示收窄方式（`project` / `chapter` / `file` / 换 `section`）。

### 结构审计

`auditChapterSet()` 在索引构建时跑一次，`map` 返回最多 8 条：

| code | 检查 |
| --- | --- |
| `frontmatter` | 模块章缺 frontmatter（99 豁免） |
| `h1-number` | H1 未以章号开头 |
| `section-number` | `##` 小节未按 `NN.M` 编号 |
| `duplicate-anchor` | 同一文档集内锚点重复 |
| `broken-link` / `broken-anchor` | 跨文档链接目标文件/锚点不存在 |
| `broken-related` | `related` 指向不存在的 `.md` |

只报「下一轮会读错/写错」的问题，不做排版检查；条数上限与去重避免把 map 输出本身撑爆。

### 与 `PROJECTS` 的衔接

- `PROJECTS.desktop.docs` 写目录 `docs/技术栈文档`（不是某一篇）：`kirara_start` 会按请求关键词
  选 1–3 章推荐，`kirara_profile` 只显示「N 章 + 用 map 展开」；
- `PROJECTS.desktop.techDocs` 指向同一个分章集，供 `kirara_docsync` 的 `@tech` 规则解析；
- 单篇形态（api / media 当前）仍让 `techDocs` 指向那一篇文件，规则表不用分叉。

## 文档同步（`kirara_docsync`）

为什么单独成节：`docs/` 下的 md 是**下一个会话的作业依据**（技术栈文档的构建与硬约束、API 文档的端点表、
需求现状）。代码改了而文档没改，偏差是**静默的** —— 没人报错，但后来者会照着过期事实写代码。

### 变化类型判定

`judgeChangeKind(feature, changes)` 按词表定性，顺序即优先级：

| `kind` | 信号 | 文档要求 |
| --- | --- | --- |
| `docs` | `DOC_TARGET ∧ DOC_ACTION` | 必须（本身就是文档工作） |
| `fix` | `FIX_SIGNALS`：修复 / 报错 / 崩溃 / 闪退 / 失效 / 回归 / bug / hotfix | 必须 |
| `chore` | `CHORE_SIGNALS` 且无 `FEATURE_SIGNALS`：格式化 / 代码风格 / lint / 清理缓存 / 重命名变量 / 注释调整 / 死代码 | **不要求改正文** |
| `ui` | `UI_HINTS` 或 `INTERACTION_SIGNALS` | 必须 |
| `feature` | 兜底 | 必须 |

`CHORE_SIGNALS` 刻意**不含**依赖升级 / 版本号 / 构建脚本 —— 这些恰恰会改动技术栈文档与 README
（文档里写着 NuGet 清单、Gradle 版本、发版步骤），归 `chore` 会把真正该同步的文档漏掉。

### 文档选择（`DOC_RULES`）

「变化特征 → 文档」的规则表，命中哪条会随结果返回（`why` 字段）：

| 规则 | 触发特征 | 目标文档 |
| --- | --- | --- |
| `api-surface` | 接口 / 端点 / api / controller / 鉴权 / jwt / signalr | api：`docs/Kirara Server API 完整文档.md` |
| `stack` | 技术栈 / 依赖 / 框架 / 版本 / sdk / nuget / gradle / postgres / redis / minio，以及**约束 / 构建 / slnx / x64 / assemble / 权限 / 红线** | 各端 `@tech`（分章集则按本次改动选章） |
| `ios-side` | `IOS_SIGNALS`：ios / iphone / ipad / xcode / swiftui / simctl / wkwebview / devicehub / 模拟器 / 双端 | media：`@tech` + `app/docs/Kirara Media iOS P0 Mac 执行清单.md`。**两者都不能省** —— 只改前者会让下一轮重新踩 Xcode/JAVA_HOME/DeviceHub 的坑 |
| `requirement` | 需求 / 功能 / 交互 / 流程 / 界面 / 首页 / 评论 / 设置 / 登录 / 令牌 / 实例 / 账号 / 认证 / 加密 / 方案 / 消息 / 主题 / 远程 | 各端 `@tech` |
| `readme` | 安装 / 用法 / 发版 / 版本号 / 下载 / apk / 部署 | 各端 `README.md` |

`@tech` 由 `primaryDocRel()` / 分章集解析：有分章集 ⇒ 进入选章；没有 ⇒ 落到 `PROJECTS.techDocs` 的单篇。
路径不存在的会在 `missing` 里报出来（不静默跳过）。一条规则都没命中时兜底到 `@tech`。

### 选章、选节与插入计划

分章集的 `pickDocTargets()` 与单篇走两条路：

1. **改路径 → 章**（强信号）：把 `changes` 归一成项目相对路径，与每章 `frontmatter.files` 逐条匹配
   （支持 `Views/Page.xaml(.cs)` 展开、`App.xaml.cs（ConfigureServices）` 去注释、目录前缀、basename 主干）；
   命中分数最高的一章必选，最多再带 2 章有正向标题/小节相关的章。
2. **标题/小节关键词**：`chapterTokenScore()` 只打章标题、`module`、小节标题；正文不参与选章，避免泛词把整本书拉进来。
3. **选节**：`bestSection()` 只按小节标题打分；命中 ⇒ `edit.mode='existing'`（给节号与起始行）。
   没命中 ⇒ 默认 `edit.mode='new'`：`nextSectionNumber()` 取本章最大 M + 1，`suggestAnchor()` 生成
   不与现有锚点冲突的 id，插入行 = 文件末尾行数。
4. **BUG 修复例外**：`kind='fix'` 且没命中既有小节时给 `edit.mode='chapter'`，明确要求
   「在章内定位描述旧行为的段落改写，不新增以问题命名的小节」。这是防止正文变成提交日志的关键。
5. **99 变更记录**：`set.changelogs` 里取最新一卷/单卷，作为独立 target 追加在末尾；
   单卷给「引言后插入 `## YYYY-MM-DD · 标题`」，多卷给「最新卷末尾追加 `## <max+1> · 标题`」+
   提示同步 `00-索引与编号映射.md`。`changelogStyle` / `changelogNext` / `changelogIndexRel` 随 target 返回。
6. **frontmatter**：`missingFrontmatterFiles()` 比较本次源文件与该章 `files`，列出需要补的路径。

单篇文档仍用 `pickSections()`：读 1~3 级标题，按最长命中词取前 3，并把「更新记录」纳入候选。

`featureTokens()` 从「改动描述 + 变更文件」里抽特征词：整词 + 中文 2-gram + 文件名主干，
并剔除 更新 / 同步 / 文档 这类泛词。抽 2-gram 是有意的：中文没有词边界，整句匹配永远命中不了标题；
代价是偶尔出现相关性一般的建议 —— 它是**给模型的提示**，不是必须照做的指令，所以宁滥勿缺。

## 发布链路（`kirara_release` / `kirara_release_notes`）

这是插件里唯一**有不可逆副作用**的一段，所以它的设计原则与其余工具相反：其余工具在「给模型信息」，
这两个在「替模型做决定，而且做错了收不回来」。由此派生三条约束：

1. **不发明流程，只固化各端已经在用的流程。** 打包口径写在 `PROJECTS[].release` 里，而不是散在
   `execute` 里 —— 三端的发布现实（脚本路径、版本号来源、产物命名、前置条件）差异极大，
   混在一起必然写成 if-else 泥潭。
2. **动手之前先把所有前置条件查一遍。** docker 没起、`keystore.properties` 缺失、README 没跟上，
   都要在跑构建 / 打包**之前**拦下 —— 失败发生在 `docker save` 之后，意味着磁盘上已经躺着
   半个几 GB 的 tar 文件。
3. **凡是有校验的地方都必须真校验。** 脚本给了校验码不算数，重新算一遍比对，对不上判失败。
   照单全收等于把校验这一步变成装饰。

### `PROJECTS[].release` 字段

| 字段 | 含义 |
| --- | --- |
| `versionFrom` | 版本号从哪读。数组；每项 `{ file, re, pick? }`，`re` 的第 1 个捕获组即版本号。多个来源解析出的版本**不一致时判失败** —— desktop 的 `installer/Kirara_Server_Setup.iss` 与 `Kirara_Server_Studio.csproj` 必须两处一致，不一致时打出来的包和显示的版本号就会是两回事 |
| `bump` | `none`（重新打包当前版本）/ `patch` / `minor` / `major`。默认 `none`；api 是唯一默认 `patch` 的端，因为它没有版本文件，只能按文档里的最高版本 +1 |
| `publish` | 跑哪个自带脚本。desktop 不需要额外参数；media 需要 `-Version` / `-OutputDir` 两个参数名 |
| `package` | 产物怎么来、叫什么。`mode: 'collect'` = 脚本产出固定文件名，插件找出来改名；`mode: 'script'` = 脚本自己输出到目标目录，插件**核验**（规范名不存在时按 `from.re` + mtime 快照找出「本次新产生/被改写」的候选，唯一才改名、并同步改写校验码正文里的文件名；候选不唯一则拒绝猜测）；`mode: 'docker-tar'` = api 的 `docker build` + `docker save` |
| `preflight` | 前置条件：`docker`（守护进程可用）/ `file`（某个文件必须存在） |
| `readme` | 给用户看的 README，发布门禁逐个检查。数组为空表示该端跳过这一步（api 就是） |

### 版本号解析与递增

`readProjectVersion()` 按 `versionFrom` 逐个读；`bumpVersion()` 的 `patch` 只动最后一段，
`minor` / `major` 会把低位清零。**没有版本文件的端**（api）改成从技术栈文档里扫
`kirara-api:X.Y.Z` 取最大值 —— 这是让「版本号只有一个来源」这个不变量在 api 端也成立的唯一办法。

解析不出任何版本号时**不猜**：直接 `blocked`，要求显式传 `version`。

### 提交分类（`kirara_release_notes`）

`classifyCommit(subject)` 的顺序是刻意的：**约定式前缀优先于关键词**。反例是实测里真实存在的

```text
feat(应用内更新): 应用内 APK 下载/校验/安装，并修正互动预览（0.9.7-beta）
```

它同时含 `feat` 和「修正」。先看关键词就会把这条新增功能丢进「修复」桶，而「修复不写进 README」
是硬规则 —— 于是这个功能在给用户看的文档里凭空消失，而且没人会去补。

区间内标题重复的会被折叠（合过分支的仓库里，同一条提交会经另一条父链再次进入历史；实测后端仓库
65 条里有 20 条是这种），折叠了几条在 `warnings` 里明说。每个桶的**真实条数**由 `counts` 单独给出，
列表被限量截断时桶标题也会写明「仅列前 N 条」—— 否则读的人无法区分「真的只有 5 条」和「后面还有 30 条」。

### 区间基线

`from` 优先；否则取 HEAD 上**版本号最大**的 tag；都没有就退回首提交，并在 `warnings` 里明说。
后端仓库（`Kirara_Server-API`）没有任何版本 tag，所以它的区间是整段历史 —— 这种情况下
显式传 `from` 比什么都管用。

### README 门禁

判定表见 [README「发布前的 README 门禁」](../README.md#发布前的-readme-门禁)。设计上只有一条原则：
**证据不足时只提醒，不拦人**。一个在拿不到证据时也拦人的门禁，最后一定会被 `force` 绕过，
而 `force` 用多了就等于没有门禁。硬拦只在证据明确且为负面时发生（`stale` / `unchanged` / `missing`）。

## 视觉复核链路

`kirara_verify` 收到 `screenshots` 时会在返回里加一段 `screenshotReview`：

| 字段 | 含义 |
| --- | --- |
| `provider` / `model` | 固定为 `chatecnu` / `ecnu-plus` |
| `purpose` | `acceptance`（能不能发）或 `ui-design`（该怎么改） |
| `screenshots[].path` | 归一化后的绝对路径 |
| `screenshots[].exists` | 插件实际 `stat` 的结果，缺文件会标出来，不静默跳过 |
| `instruction` | 一段可直接执行的复核提示词 |

### 两种 purpose 是不同的作业

| `purpose` | 提问方式 | 下游动作 |
| --- | --- | --- |
| `acceptance`（默认） | 逐张「通过 / 不通过 + 依据」 | 有不通过项就修，修完重截复核 |
| `ui-design` | ① 视觉层级/对齐不一致的元素（指名控件 + 建议数值）② 改动是否真的可见、是否破坏相邻区域 ③ 截断/溢出/对比度/缺图标/缺空态/深色主题不可读 ④ 每条标 P0/P1/P2 并写成「改哪个文件或控件 → 改成什么」 | 改 P0/P1 → 同状态重截 → 再跑一次，直到没有 P0/P1 |

`ui-design` 的提示词是给**改代码**用的，所以它要求可落地；只输出「不好看」等于没输出。

### UI 改动必经截图（机器化兜底）

`uiWork = purpose === 'ui-design' ∨ UI_HINTS.test(summary) ∨ INTERACTION_SIGNALS.test(summary)`。
`uiWork` 为真时：

- 清单里插入截图步骤（同一窗口尺寸/主题下各状态一张）与一条「改完重截复核」的收尾步骤；
- 没传 `screenshots` 时返回 `needScreenshots`（可选键，条件展开），明确要求先向用户索取截图，
  并禁止在拿到图之前宣称样式已对齐。

这条兜底存在的理由：`purpose` 是模型传的，模型可能忘；而 `summary` 是每次都会传的。
只靠 `purpose` 的话，「UI 改动没看截图就收尾」仍然会发生。

**插件为什么不自己调模型**：插件跑在 DSH 宿主进程里，只拿得到 `ctx.tools`，拿不到会话级的 `llm` 服务。
所以它只产出「怎么调」的协议，真正的多模态请求由模型按协议发起，把每张图作为 attachment 发给
`ecnu-plus`。这样插件保持无副作用，也能离线自检。

模型选择依据：profile 的 `llm-pi-ai` 配置里，`ecnu-plus` 是声明了 `input: [text, image]` 的模型；
`ecnu-max` 仅文本；`ecnu-image-pro` 已下线。

## 实时视觉迭代环（`kirara_ui`，2026-11）

「截图复核」解决的是「改完有没有人看过」，但它发生在**整条自检链路之后**：
改代码 → 全量自检（约 4 分钟）→ 4 张固定截图 → 看着返工。内环之所以慢，是因为三个结构性事实：

1. 截图是**构建脚本的副产物**，不是「我想看哪屏就看哪屏」；
2. `simctl` 不能点也不能打字（P0 清单 §9.7），「先走到目标界面再截图」在 iOS 上原本无解；
3. 一次「改 → 看」的反馈周期 = 一条自检脚本，而不是一张图。

MCP 服务器更新后，三个事实被补上：Xcode MCP 的 `DeviceInteractionSynthesize` 能在模拟器上
点按/输入并回传截图 + UI 层级，`RenderPreview` 能直接渲染 SwiftUI 预览；Android 侧有
`adb-mcp` / `mobile-mcp` 这类设备控制服务提供截图、点击、UI 树。但「能调」不等于「会调」——
模型不知道本机装了哪个、工具叫什么、参数怎么填时，就会退回盲改。

这一层因此只做四件事：

| 职责 | 实现 | 为什么这样做 |
| --- | --- | --- |
| **发现** | `discoverUiMcp(ctx.tools.definitions())` | 工具名是宿主解析后的真实集合，`mcp__<ns>__<raw>` 里按名字认出截图 / 点按 / UI 树 / 预览四类能力。**只输出能力名，不倒全表**——返回值会永久留在上下文里 |
| **兜底桥** | `probeIosDevice` / `probeAndroidDevice` / `captureShot` | 本机本来就装了 `simctl` / `adb`。少了第三方 MCP 也要能出图，否则「少装一个服务」直接变成环停摆 |
| **证据** | `<Kirara_Media>/iosApp/.tmp/ui-loop/shot-NN.png` + `state.json` | 证明「看过」的是**文件**，不是模型的自述。目录在 media 的 `.gitignore` 里整棵忽略，`gradlew clean` 也不会动它 |
| **迭代** | `iterations` / `openIssues` | `review` 带 `issues` 就记一轮；`closed = 截图 ≥1 ∧ 迭代 ≥1 ∧ 未修 = 0`。`kirara_verify` 与 `kirara_summary` 读同一份判据 |

### 四个 action

| `action` | 作用 | 副作用 |
| --- | --- | --- |
| `plan`（默认） | 探测设备 + 发现 MCP，输出「这一轮怎么转」的五步与 8 条设计轴 | 无（只读） |
| `shot` | 抓一张（`simctl io screenshot` / `adb exec-out screencap`）或采纳已有截图（`paths`） | 写证据目录与状态 |
| `review` | 记一轮迭代；`issues` 非空 = 未闭环并明确「不要写进总结当已完成」，空 = 收敛 | 写状态 |
| `status` | 只读环状态与闭环判据 | 无 |

### 三个刻意绕开的坑

**① `adb exec-out screencap` 不能走字符串管道。** `runProcess()` 把 stdout 当 UTF-8 拼接，
PNG 会变成坏图**且不报错**。所以另有一个 `runProcessToFile()`（`createWriteStream` + 二进制管道），
并且等 `stream.end()` 回调再收尾，否则紧接着读文件会拿到截断的图。

**② 模拟器要按 UDID 选，不能按写死的机型名。** `PROJECTS.media.ios.device` 写的是
`iPhone 18 Pro`，而某台机器上只装了 `18 Pro Max`：`xcodebuild` 会回落 "My Mac" 并报
doesn't match 平台。`pickSimulator()` 的优先级是「配置名 → booted 的 iPhone → 任意 booted →
第一台可用 iPhone」，与 `run-simulator.sh` 的自愈逻辑一致。

**③ 「点按」这一格必须挑真正执行手势的工具。** Xcode MCP 里 `DeviceInteractionStartSession`
与 `DeviceInteractionSynthesize` 名字都含 `interaction`，但只有后者接受 `'t x y'`。
所以发现顺序是 `synthesize` → `tap/click/swipe` → `interaction`。

### 与既有链路的关系

- `kirara_start`：UI 改动的路线从「构建 → 截图 → 复核」改成「先 `kirara_ui` 内环 → 收敛后 build + verify」；
  它的 `detail="route"` 取代了原来的 `kirara_route`（见[外部强模型交接](#外部强模型交接kirara_handoff2026-11)）；
- `kirara_build(target='ios')`：全量自检仍然保留，但定位改成**收敛后的验收**（返回值里明说别拿它做迭代）；
- `kirara_verify`：视觉环未闭环时多给一步「先 `status` 看差什么」；`ui-design` 缺截图时 `needScreenshots` 指向 `kirara_ui`；
- `kirara_summary`：未闭环写进「遗留风险」，零截图也点名 —— 否则「已完成」就是没有证据的自述。

### 可选：把设备控制 MCP 交给插件注册

配置了 `uiMcpServer` + `uiMcpCommand` 时，`apply()` 会用 `ctx.inject(['mcpManager'], …)` 注册一个
stdio 服务器（`ctx.mcpManager.register(name, entry)`），生命周期跟随插件：卸载即摘除，不留孤儿。

三条边界：没配 `command` 就什么都不做；用 `ctx.inject` 而不是把 `mcpManager` 写进 `inject` 数组
（否则没挂 mcp-manager 的 profile 上整个插件挂不起来）；注册失败只打日志，环靠兜底桥继续转。

## 外部强模型交接（`kirara_handoff`，2026-11）

### 在整体链路里的位置

前九节描述的都是「DSH 自己从头做到尾」。`kirara_handoff` 给这条链开了**一个可切换的中段**：

```text
kirara_start（解读 + 定路线 + 该读哪些文档）        ← DSH
        ├─ 交给 DSH 自己：改代码 → build → ui → verify
        └─ 交给外部强模型：open（brief） → 它做 2/3 阶段 → close（report）
kirara_docsync（文档同步）                          ← DSH，两条链在这里合流
kirara_summary / kirara_release_notes / kirara_release
```

它**不替换任何既有工具**：`kirara_build` / `kirara_ui` / `kirara_verify` 仍是 DSH 侧的验证手段，
外部模型那边只是复用同一批事实（`PROJECTS` 的构建命令与约束、`docsForProject()` 的文档线索、
`searchDocScopes()` 的检索结果）。这也意味着**同一个需求在哪条链上得到的事实是一致的**。

### 两个路由入口为什么合并成一个

`kirara_route` 与 `kirara_start` 的差别只有「要不要顺带给文档清单与构建命令」，判定逻辑却必须
永远一致 —— 两条入口同时存在时，模型会随机挑一条，而同一个需求在两条路上得到不同 `mode`
只是时间问题。所以 `kirara_route` 被并入 `kirara_start(detail="route")`：

- 判定抽成 `resolveRoute()`，`detail="full"` / `detail="route"` / `kirara_handoff(open)` **三处同源**；
- `detail="route"` 的字段名保持 `plan` / `requiresDeviceVerification` / `nextStep`，老调用方不用改；
- 唯一的行为差异是刻意的：`detail="route"` **不做 auto 判定**（缺 `mode` 或传 `auto` 直接回 STOP），
  因为这条路径的语义就是「我已经知道 mode 了」。要自动判定用默认的 `detail="full"`。
- 工具目录这一轮的账：−620（删掉 `kirara_route`）+133（`kirara_start` 的 `detail` 参数与两处分支）
  +889（新增 `kirara_handoff`）= **净增 402 字节**，也就是「合并入口」把新工具的增量压掉了三分之二。

### 落盘与路径安全

- 目录默认 `<workspaceRoot>/.kirara-dev/handoff/<runId>`，`runId = KH-YYYYMMDD-HHMM`（本地时间）。
  同一分钟连续 `open` 会补 `-2` / `-3`，**先看目录是否已存在**再决定，所以两次 `open` 绝不互相覆盖。
- `handoffRunDir()` 用**严格正则 + resolve 后再确认仍在根内**两道关：`../../x` 连目录都不会被创建。
- 不碰用户仓库的 `.gitignore`（副作用大且会出现在别人的 diff 里），只在目录里放 `README.txt`。
- `screenshots[].path` 只在 `shots/` 内解析并 `stat`；越界的路径标 `outside` 且**不做 stat** ——
  外部输入不能成为「探测任意路径是否存在」的通道。

### 回执校验的三条硬规则

1. **缺 `status` / `summary` / `changed` 任意一项 ⇒ 拒收且不写 `report.json`。**
   半份结构写下去，下一步的文档同步会拿它当事实，比没有更糟。
2. **`changed[].file` 原样保留。** 它是 `kirara_docsync({ changes })` 的唯一输入 —— 一旦这里悄悄
   改写路径（补前缀、换斜杠），选章就会选错，而错法是静默的。
3. **回执里的字符串永不执行。** 结构校验 + 落盘，就这两件事。`commands[]` 只是给人看/归档的记录，
   插件不会去重跑它们。

失败处理（外部模型只回了一半、声称 done 但没截图、越界改了 docs/ 等）见
[外部强模型交接](handoff.md)。

## 返回值约束

所有工具的返回值必须是 **lossless JSON**：可选键在条件不成立时要**整键省略**，不能赋 `undefined`。
宿主对返回值做逐键 visit，值为 `undefined` 的自有可枚举键会被直接判负，
表现为 `tool "..." returned invalid output: value is not lossless JSON`。

写法：

```js
...(r.code == null ? {} : { exitCode: r.code }),
...(artifact === undefined ? {} : { artifact }),
```

注意不能用 `?? null` 兜 —— `exitCode` 在 schema 里声明为 `integer`，`null` 会被
`must be an integer` 拒掉；只有 schema 允许 `null` 的键才能这样兜。

这条约束是**逐个工具**生效的，不会因为同类问题修过一次就免疫。新增任何带可选字段的返回值时，
都要问一句「这个键在什么入参下会是 `undefined`」，并让 `contract-test.mjs` 显式覆盖那个入参。

## 维护同步点

| 变化 | 要改哪里 |
| --- | --- |
| 某端构建方式 / TFM / 硬约束变了 | `lib/impl.js` 的 `PROJECTS` |
| 新增或调整关键词路由 | `ROUTE_SIGNALS` / `UI_HINTS` / `INTERACTION_SIGNALS` / `DESTRUCTIVE_SIGNALS` |
| 新增或调整「纯文档变更」判定 | `DOC_TARGET` / `DOC_ACTION` / `DOC_STRUCTURE` / `DOC_CODE_OBJECT` |
| 新增或调整「该同步哪几篇文档」 | `DOC_RULES`（规则表）与 `CHORE_SIGNALS` / `FIX_SIGNALS` / `FEATURE_SIGNALS`（定性） |
| 新增/调整分章文档的发现、编号、锚点、审计规则 | `findChapterDirs` / `parseDocFile` / `auditChapterSet`，并同步 `docs/doc-conventions.md` 与 `scripts/doc-layer-test.mjs` |
| 换了视觉复核模型 | `VISION_PROVIDER` / `VISION_MODEL` |
| 改了交接包的九节文案 / prompt / 回执契约 | `lib/prompts.js`（纯函数，`scripts/handoff-test.mjs` 覆盖），并同步 `docs/handoff.md` |
| 改了交接目录的结构 / 回执校验规则 | `handoffRoot` / `handoffRunDir` / `handoffNewRunId` / `handoffCheckReport` |
| 改了任何工具的 description / 参数 / 输出预算 | `node scripts/cache-budget.mjs`，并把 `BUDGET` 基线一起改 |

改完 `lib/impl.js`（实现层：工具、流程、`PROJECTS`）后需要同步一次才生效：插件详情页点「同步更新」
（引导层热重载，不用重启），或 `node scripts/deploy.mjs` 重新部署 —— `file:` 安装是拷贝，不是软链。
改 `lib/index.js`（引导层）/ `lib/update.js`（内核）/ `cordis.patch.yml` / `package.json`，
则要重新部署并**完全重启 DSH**（这几个只在启动时读一次）。
