# dsh-plugin-kirara-dev

[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件，把 Kirara 三端项目
（`kirara_server` / `kirara_-server-api` / `Kirara_Media`）的开发流程做成模型可以直接调用的工具。

> Kirara Dev Flow — route a request to the right projects, search the docs, run the real build,
> then hand over a device-acceptance checklist.

装好之后模型手里会多出七个 `kirara_*` 工具，覆盖「读文档 → 定路线 → 改代码 → 跑构建 → 出验收清单 → 收尾」
这整条链路。它主要解决两件事：

- **文档太大，不能整篇读**。单篇技术文档最大 258 KB，`AGENTS.md` 有 153 KB，整篇塞进上下文会把它挤爆。
  插件改成按关键词检索，只取需要的片段。
- **三端构建命令各不相同，而且都有坑**。API 端的 `.slnx` 是坏的，桌面端必须显式指定平台，Android 端不跑单元测试。
  这些直接内置成工具，顺带把实测可用的命令固化下来。

## 功能

| 工具 | 说明 |
| --- | --- |
| `kirara_start` | **入口**。给一句话需求，返回涉及哪几端、该先读哪几篇文档、各端构建命令、是否需要实机验证、有没有需要你拍板的问题 |
| `kirara_profile` | 返回三端的项目画像：技术栈、构建/运行命令、硬约束。用来替代整篇读 `AGENTS.md` |
| `kirara_docs` | 在技术文档里按关键词检索，返回 `文件:行号` 和所属章节 |
| `kirara_route` | 把一句话需求展开成路线：涉及端、执行步骤、决策点 |
| `kirara_build` | 跑真实构建，返回成功与否、退出码、耗时、错误行、日志尾部 |
| `kirara_verify` | 产出分步的真机验收清单（步骤 + 预期结果）；传入截图路径可以额外拿到一段视觉复核协议 |
| `kirara_summary` | 汇总本轮变更、构建结论、验证状态、遗留风险 |

### 自动判断这轮要不要实机验证

`kirara_start` 的 `mode=auto` 先按 `full` 探一遍，命中下面任一条就保持 `full`：

- 请求涉及**用户可见的效果** —— 界面、渲染、布局、配色、图标、动画，或者评论、回复、@提及、
  通知、点赞这类交互功能
- 请求是**破坏性改动** —— 删除、下线、重构，或者数据库结构变更

都不命中才降为 `small`，也就是构建通过即完成。判定命中了哪条信号会随结果一起返回（`reasons` 字段），
误判时可以直接看出是哪条规则的问题。

这条规则刻意偏保守，因为两种误判的代价不对称：把可见功能误判成 `small` 会让人跳过实机验收直接发出去；
误判成 `full` 只是多走一遍清单。另外「构建通过」本身也只证明能编译，不证明效果对。

### 内置的构建命令

| 端 | 仓库目录 | 构建命令 |
| --- | --- | --- |
| desktop | `kirara_server` | `dotnet build Kirara_Server-WinUI.slnx -c Debug -p:Platform=x64 --nologo` |
| api | `kirara_-server-api` | `dotnet build Kirara_Server-API.Server/Kirara_Server-API.Server.csproj -c Debug --nologo` |
| media | `Kirara_Media` | `gradlew.bat assembleDebug --console=plain` |

`kirara_build` 在 DSH 宿主进程里执行，因此不受 PowerShell 沙箱的 stdio 限制，也不占用工具调用超时。
默认单次构建最长等 20 分钟，够 Gradle 冷启动。

## 前置条件

这个插件是**薄编排层**，本身不含任何 Kirara 代码。要真正用起来，你需要先有 Kirara 三端仓库本身：

| 需要 | 用于 |
| --- | --- |
| DSH 0.2.x | 插件运行环境 |
| Kirara 三端仓库（至少你关心那一端） | 被编排的对象 |
| .NET 10 SDK + WinUI 3 工作负载 | `kirara_build` 构建 desktop |
| JDK 17 + Android SDK | `kirara_build` 构建 media |
| 一个支持图像输入的 chat 模型路由 | `kirara_verify` 的截图复核（可选） |

只装插件、不备工具链也能用 `kirara_start` / `kirara_docs` / `kirara_route` 做路由和检索。

## 安装

### 1. 添加插件

侧栏 **插件** → **添加插件**，填入仓库地址：

```
git+https://github.com/akeno6388/dsh-plugin-kirara-dev.git
```

也接受 `https://github.com/akeno6388/dsh-plugin-kirara-dev` 和本地绝对路径。
命令行等价物是 `dsh plugin --profile <profile> add <spec>`。

用 `git+https://` 而不是 `github:owner/repo` 简写：pnpm 会把简写改写成 `git+ssh://`，
没配 GitHub SSH key 的机器会直接 `Host key verification failed`。

如果 `github.com:443` 访问超时，可以换 Gitee 镜像地址。

### 2. 启用

安装完成界面点 **立即启用**，或回到插件列表打开该组合包的开关。

### 3. 指向你的仓库

插件按 `DSH_WORKSPACE` → 当前工作目录的顺序推测 Kirara 仓库根目录，也就是三端仓库的**父目录**。
猜不中就在自己 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: kirara-dev
  config:
    workspaceRoot: 'D:\path\to\your\kirara-root'
```

配置是**整行替换**，没写的字段会回落到插件内置默认值。改完要**完全重启 DSH** —— bundle 只在启动时读一次。

## 使用

### 一句话启动

```
kirara_start({ request: '优化 kirara_docs 的关键词检索排序' })
```

返回里会给出涉及端、建议先读的文档、构建命令和是否需要实机验证。按它给的步骤改完代码后：

```
kirara_build({ project: 'desktop' })
kirara_summary({ feature: '优化关键词检索排序', mode: 'small', changes: ['dsh-plugin-kirara-dev/lib/index.js'] })
```

### 直接调用单个工具

跳过路由也可以，七个工具都能单独用：

```
kirara_profile({})                                 // 三端画像
kirara_profile({ project: 'api' })                 // 只看 API 端
kirara_docs({ keywords: ['MinIO', '预签名'] })      // 跨文档检索
kirara_docs({ keywords: ['评论'], project: 'api' }) // 限定单个子项目
kirara_build({ project: 'media' })                 // 构建 Android 端
kirara_verify({ summary: '设置页加暗色开关', project: 'media', mode: 'full' })
```

### 用截图做视觉复核

这个项目不写单元测试，验证方式 = 构建 + 人工真机清单，人工清单由 `kirara_verify` 产出。
如果已经截好图，可以把路径一并传进去，先让图像模型过一遍：

```
kirara_verify({
  summary: '设置页加暗色开关',
  project: 'media',
  mode: 'full',
  screenshots: ['D:/shots/settings-dark.png', 'D:/shots/settings-light.png'],
})
```

返回里会多出一段 `screenshotReview`，包含每张图的绝对路径、文件是否真实存在（插件会去 stat，
缺文件会标出来而不是静默跳过），以及一段可以直接执行的复核提示词。

提示词固定问四件事：是否正常渲染（白屏 / 错位 / 乱码 / 占位图）、本次改动对应的界面是否可见、
有无明显异常（错误弹窗、缺失图标、对比度问题）、逐条给出通过或不通过的依据。它明确要求不要臆测
截图里看不到的内容。

插件自身不调用模型，只产出「怎么调」的协议 —— 实际的图像请求由模型按协议发起，
把每张图作为 attachment 发给支持图像输入的模型。这样插件保持无副作用、可以离线自检。

### 配置项

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `workspaceRoot` | `''` | 三端仓库的父目录。留空时依次回退到 `DSH_WORKSPACE`、当前工作目录 |
| `buildTimeoutMs` | `1200000` | 单次构建最长等待（20 分钟） |
| `buildLogTailLines` | `60` | 回传的日志尾部行数 |

## 兼容性

`peerDependencies` 声明为 `@deepseek-ai/dsh-tools@^0.2.0-rc.2`，覆盖 DSH 0.2.x 全系列
（`0.2.0-rc.2` / `0.2.0` / `0.2.1` 均可用）。

`0.3.0` 起会被判 incompatible 并自动禁用。换大版本后如果仍想用，需要 `dsh plugin allow-version`
显式授权 —— 插件没有针对新版本测过，有崩溃风险。

## 升级

插件暂不支持自动更新。先在插件页卸载，再用新地址重装一次。

## 常见问题

**装完在工具表里看不到 `kirara_*`？**
先确认插件已启用，然后**完全退出 DSH 再重启** —— 不是关窗口，也不是刷新页面，bundle 只在启动时读一次。
重启后请在**新会话**里验证：旧会话的历史消息里已经录下了加载失败时的工具快照，旧记录不会自动修复。

**`kirara_profile` 返回的 `workspaceRoot` 不对？**
按「安装」第 3 步覆盖配置，或者给 DSH 进程设置 `DSH_WORKSPACE` 环境变量。

**`kirara_build` 构建 api 报 `MSB3202`？**
那是构建整解 `.slnx` 才会踩的坑：`Kirara_Server-API.slnx` 引用了不存在的
`test-assets/DbCheck/DbCheck.csproj`，整解构建会在 0.8 秒内失败。`kirara_build` 已经改成构建
`Kirara_Server-API.Server` 单项目，会带出 Core / Infrastructure / Shared，绕开了这个引用。
如果你在命令行里手动构建，也请构建单项目而不是整解。

**桌面端构建报平台相关错误？**
`Kirara_Server-WinUI.slnx` 只注册了 `x64`，必须显式传 `-p:Platform=x64`。

**为什么没有单元测试？**
这是项目约定：验证方式 = 构建 + 人工真机清单。所以 `kirara_verify` 产出的是分步骤清单，不是测试代码。

**能用 `kirara_build` 验证这个插件自己吗？**
不能。`kirara_build` 只覆盖 desktop / api / media 三个子项目。插件自身的验证方式是
`node scripts/deploy.mjs --check` 加完全重启，见[本地开发](docs/local-development.md)。

**`kirara_build` 会杀掉我的 `dotnet` 进程吗？**
不会。插件只运行构建命令，不做任何进程清理。它内置的进程清理红线是给模型看的提示：禁止按进程名
批量杀 `dotnet.exe`（VS Code 的 C# Dev Kit 依赖它），禁止 `dotnet build-server shutdown`
（会打断 VS Code 复用的 MSBuild 节点）。Android 端收尾用 `gradlew --stop`。

**支持哪些模型？**
工具本身与模型无关。只有 `kirara_verify` 的截图复核需要一个声明了 `input: [text, image]` 的模型路由。

**能发到 npm 吗？**
可以，但发布前要先改三处，否则 `npm publish` 会被直接拒绝：

| # | 改什么 | 为什么 |
| --- | --- | --- |
| 1 | 删掉 `package.json` 的 `"private": true` | 它是 `npm publish` 的硬性拦截（不影响 git 安装） |
| 2 | 处理 `@kirara` 作用域 | npm 上 scoped 包必须有对应 organization；不想建就改包名，并同步改 profile 依赖名与 `dsh.profile.bundles` |
| 3 | 加 `"publishConfig": { "access": "public" }` | 不加会按默认可见性处理，可能发成私有 |

发布后用户可以只填包名安装，DSH 会在 npm 官方源与 npmmirror 之间自动探测。

**想改插件代码，怎么让改动生效？**
见[本地开发](docs/local-development.md)。

## 文档

- [架构与项目画像](docs/architecture.md) —— 七个工具的实现、路由判定信号、`PROJECTS` 常量怎么维护
- [DSH 插件契约](docs/plugin-contract.md) —— 插件要怎么写才会被 DSH 认可并加载
- [本地开发](docs/local-development.md) —— 挂载到 profile、部署脚本、四个自检夹具
- [故障排查](docs/troubleshooting.md) —— 怎么判断插件加载了没，以及几个已经踩过的坑

## 许可

MIT
