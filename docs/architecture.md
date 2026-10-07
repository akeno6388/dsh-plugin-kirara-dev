# 架构与项目画像

## 代码结构

插件是**直接可加载的 ESM 源码**，没有构建步骤 —— DSH 的 loader 直接 `import()` 它。

```
dsh-plugin-kirara-dev/
├── package.json               # bundle 声明（dsh.bundle.patch）+ peerDependencies 契约
├── cordis.patch.yml           # insert 层，刻意不写任何与作者机器相关的字段
├── lib/index.js               # 全部插件逻辑
├── locale/{zh,en}.json        # 插件在插件列表里显示的名称与描述
├── scripts/                   # 开发期自检夹具，不进 profile
│   ├── selftest.mjs
│   ├── deploy.mjs
│   ├── mount-check.mjs
│   ├── contract-test.mjs
│   └── host-interception.mjs
└── docs/
```

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
| `docs` | 该端相关的技术文档路径，`kirara_start` 按这个列表推荐要读的文档 |
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

### 空请求

`request` 为空时不猜，直接返回 `blocked: true` 和一条追问性质的 `decisions`，让调用方先问清楚。

## 视觉复核链路

`kirara_verify` 收到 `screenshots` 时会在返回里加一段 `screenshotReview`：

| 字段 | 含义 |
| --- | --- |
| `provider` / `model` | 固定为 `chatecnu` / `ecnu-plus` |
| `screenshots[].path` | 归一化后的绝对路径 |
| `screenshots[].exists` | 插件实际 `stat` 的结果，缺文件会标出来，不静默跳过 |
| `instruction` | 一段可直接执行的复核提示词 |

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
| `.slnx` 悬空引用修好了 | `PROJECTS.api.build.args` 与 `constraints` |
| 换了视觉复核模型 | `VISION_PROVIDER` / `VISION_MODEL` |

改完 `lib/index.js` 后需要 `node scripts/deploy.mjs` 同步到 profile 才会生效（`file:` 安装是拷贝，
不是软链）。`cordis.patch.yml` 与 `package.json` 只在启动时读一次，改这两个必须完全重启 DSH。
