# 架构与项目画像

## 代码结构

插件是**直接可加载的 ESM 源码**，没有构建步骤 —— DSH 的 loader 直接 `import()` 它。

```
dsh-plugin-kirara-dev/
├── package.json               # bundle 声明（dsh.bundle.patch）+ peerDependencies 契约
├── cordis.patch.yml           # insert 层，刻意不写任何与作者机器相关的字段
├── lib/                       # 宿主半边，四层（自更新见 docs/self-update.md）
│   ├── index.js               #   引导层：挂实现 + 自更新路由 + 热重载（很薄）
│   ├── impl.js                #   实现层：全部插件逻辑（10 个 kirara_* 工具）
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
│   ├── cache-budget.mjs       # 前缀缓存回归：工具目录逐字节稳定 + 返回值预算
│   ├── update-e2e.mjs         # 自更新端到端（离线假 GitHub + 真 cordis + 真引导层）
│   ├── update-live-check.mjs  # 自更新真实链路（联网打真 GitHub）
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
| `docs` | 该端相关的技术文档路径。`kirara_start` 按这个列表推荐要读的文档，`kirara_docsync` 把它当作「该同步哪些文档」的候选来源 —— 所以**只列真实存在的文件**，列了不存在的路径只会产出死链推荐 |
| `constraints` | 该端的硬约束，会随 `kirara_profile` 一起返回 |
| `apk` | 仅 media 有，构建产物路径，`kirara_build` 用它判断产物是否真的生成 |
| `release` | 该端的发布现实：版本号从哪读、是否递增、跑哪个脚本、产物怎么命名、有哪些前置条件、哪几篇 README 要过门禁。细节见[发布链路](#发布链路kirara_release--kirara_release_notes) |

三端的当前值：

| 端 | 目录 | 技术栈 | 目标框架 |
| --- | --- | --- | --- |
| desktop | `Kirara_Server_Studio` | WinUI 3 (Windows App SDK 2.3.1) + C# 13 + .NET 10 + CommunityToolkit.Mvvm 8.4 + LiteDB | `net10.0-windows10.0.19041.0` |
| api | `Kirara_Server-API` | ASP.NET Core 10 + Aspire 13.2.4 + PostgreSQL 16 / EF Core 10 + Redis + MinIO + SignalR | — |
| media | `Kirara_Media` | Kotlin + Jetpack Compose + Hilt + OkHttp + Coil + kotlinx.serialization | — |

### 内置命令里刻意绕开的坑

- **api 不构建 `.slnx`**：`Kirara_Server-API.slnx` 引用了不存在的 `test-assets/DbCheck/DbCheck.csproj`，
  整解构建会以 `MSB3202` 在 0.8 秒内失败。改成构建 `Kirara_Server-API.Server` 单项目，
  会带出 Core / Infrastructure / Shared。悬空引用修掉之后可以换回整解构建，同步改
  `PROJECTS.api.build.args` 与 `constraints` 即可。
- **desktop 必须显式给平台**：`Kirara_Server-WinUI.slnx` 只注册了 `x64`，命令里固定带 `-p:Platform=x64`。
- **media 不跑单元测试**：按项目约定只用 `gradlew.bat assembleDebug`。

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
| media | `android` / 安卓 / 手机 / `apk` / `compose` / `kotlin` / `gradle` |

### 升级为 `full` 的信号

`mode=auto` 只要命中下面任一条，就不允许降级成 `small`：

| 常量 | 覆盖 | 举例 |
| --- | --- | --- |
| `UI_HINTS` | 外观 / 视觉词 | 界面、渲染、布局、样式、配色、暗色、字体、图标、动画、开关、弹窗、按钮、菜单、`xaml`、`theme` |
| `INTERACTION_SIGNALS` | 社交 / 交互功能词族 | `@`、提醒、通知、提及、评论、回复、点赞、收藏、分享、私信、聊天、消息、关注、订阅、推送 |
| `ROUTE_SIGNALS[].ui` | 某端专属的交互词 | `desktop.ui` = 评论 / 首页 / 界面 / `xaml` / 托盘 / 任务栏 |
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
| `stack` | 技术栈 / 依赖 / 框架 / 版本 / sdk / nuget / gradle / postgres / redis / minio，以及**约束 / 构建 / slnx / x64 / assemble / 权限 / 红线** | 各端技术栈文档（构建命令与硬约束的权威落点） |
| `requirement` | 需求 / 功能 / 交互 / 流程 / 界面 / 首页 / 评论 / 设置 / 登录 | desktop：`docs/技术栈文档.md`（原 `需求文档.md` 已删除、内容并入其中）；media：技术栈文档 |
| `readme` | 安装 / 用法 / 发版 / 版本号 / 下载 / apk / 部署 | 各端 `README.md` |

路径不存在的会被剔除，并在 `missing` 里报出来（不静默跳过）。一条规则都没命中时兜底到该端的
主文档（README 除外 —— 它只在安装/用法变化时才是对的目标）。

### 章节建议

`featureTokens()` 从「改动描述 + 变更文件」里抽特征词：整词 + 中文 2-gram + 文件名主干，
并剔除 更新 / 同步 / 文档 这类泛词。`pickSections()` 只读**被选中的那几篇**（最多
`docsyncMaxTargets` 篇）的 1~3 级标题，按最长命中词排序取前 3，并始终把「更新记录」纳入候选
（API 完整文档、技术栈文档都有这一节）。

抽 2-gram 是有意的：中文没有词边界，整句匹配永远命中不了标题；代价是偶尔出现
「令牌登录 / 解绑令牌 / 重试失败」这类相关性一般的建议 —— 它是**给模型的提示**，
不是必须照做的指令，所以宁滥勿缺。

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
| `versionFrom` | 版本号从哪读。数组；每项 `{ file, re, pick? }`，`re` 的第 1 个捕获组即版本号。多个来源解析出的版本**不一致时判失败** —— desktop 的 `installer/Kirara_Server_Setup.iss` 与 `Kirara_Server-WinUI.csproj` 必须两处一致，不一致时打出来的包和显示的版本号就会是两回事 |
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
| 某端构建方式 / TFM / 硬约束变了 | `lib/index.js` 的 `PROJECTS` |
| 新增或调整关键词路由 | `ROUTE_SIGNALS` / `UI_HINTS` / `INTERACTION_SIGNALS` / `DESTRUCTIVE_SIGNALS` |
| 新增或调整「纯文档变更」判定 | `DOC_TARGET` / `DOC_ACTION` / `DOC_STRUCTURE` / `DOC_CODE_OBJECT` |
| 新增或调整「该同步哪几篇文档」 | `DOC_RULES`（规则表）与 `CHORE_SIGNALS` / `FIX_SIGNALS` / `FEATURE_SIGNALS`（定性） |
| `.slnx` 悬空引用修好了 | `PROJECTS.api.build.args` 与 `constraints` |
| 换了视觉复核模型 | `VISION_PROVIDER` / `VISION_MODEL` |
| 改了任何工具的 description / 参数 / 输出预算 | `node scripts/cache-budget.mjs`，并把 `BUDGET` 基线一起改 |

改完 `lib/index.js` 后需要 `node scripts/deploy.mjs` 同步到 profile 才会生效（`file:` 安装是拷贝，
不是软链）。`cordis.patch.yml` 与 `package.json` 只在启动时读一次，改这两个必须完全重启 DSH。
