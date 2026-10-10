# 架构与项目画像

## 代码结构

插件是**直接可加载的 ESM 源码**，没有构建步骤 —— DSH 的 loader 直接 `import()` 它。

```
dsh-plugin-kirara-dev/
├── package.json               # bundle 声明（dsh.bundle.patch）+ peerDependencies 契约
├── cordis.patch.yml           # insert 层，刻意不写任何与作者机器相关的字段
├── lib/index.js               # 全部插件逻辑（8 个 kirara_* 工具）
├── locale/{zh,en}.json        # 插件在插件列表里显示的名称与描述
│                              #   （deploy.mjs 会逐字节比对这两个文件，漂移=列表显示旧文案）
├── scripts/                   # 开发期自检夹具，不进 profile
│   ├── selftest.mjs
│   ├── deploy.mjs
│   ├── mount-check.mjs
│   ├── contract-test.mjs
│   ├── cache-budget.mjs       # 前缀缓存回归：工具目录逐字节稳定 + 返回值预算
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

进 profile 的只有 `package.json`、`lib/index.js`、`cordis.patch.yml`，外加 npm 强制包含的 `README.md`
（见 `package.json` 的 `files` 数组）。`scripts/`、`docs/` 和 `node_modules/` 都不进 profile。

## `PROJECTS`：项目事实的唯一来源

`lib/index.js` 顶部的 `PROJECTS` 数组是三端项目事实的唯一来源。各端构建方式、TFM、硬约束变化时
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

三端的当前值：

| 端 | 目录 | 技术栈 | 目标框架 |
| --- | --- | --- | --- |
| desktop | `kirara_server` | WinUI 3 (Windows App SDK 2.3.1) + C# 13 + .NET 10 + CommunityToolkit.Mvvm 8.4 + LiteDB | `net10.0-windows10.0.19041.0` |
| api | `kirara_-server-api` | ASP.NET Core 10 + Aspire 13.2.4 + PostgreSQL 16 / EF Core 10 + Redis + MinIO + SignalR | — |
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

为什么单独成节：`docs/` 下的 md 是**下一个会话的作业依据**（AGENTS.md 的约束、API 文档的端点表、
需求文档的功能现状）。代码改了而文档没改，偏差是**静默的** —— 没人报错，但后来者会照着过期事实写代码。

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
| `stack` | 技术栈 / 依赖 / 框架 / 版本 / sdk / nuget / gradle / postgres / redis / minio | 各端技术栈文档 |
| `requirement` | 需求 / 功能 / 交互 / 流程 / 界面 / 首页 / 评论 / 设置 / 登录 | desktop：`docs/需求文档.md`；media：技术栈文档 |
| `readme` | 安装 / 用法 / 发版 / 版本号 / 下载 / apk / 部署 | 各端 `README.md` |
| `agents` | 约束 / 构建命令 / 流程 / 规范 / 平台 / slnx / assemble | 各端 `AGENTS.md` |

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
