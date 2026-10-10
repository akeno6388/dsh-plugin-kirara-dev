# dsh-plugin-kirara-dev

[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件，把 Kirara 三端项目
（`kirara_server` / `kirara_-server-api` / `Kirara_Media`）的开发流程做成模型可以直接调用的工具。

> Kirara Dev Flow — route a request to the right projects, search the docs, run the real build,
> then hand over a device-acceptance checklist.

装好之后模型手里会多出八个 `kirara_*` 工具，覆盖「读文档 → 定路线 → 改代码 → 跑构建 → 出验收清单 →
同步文档 → 收尾」这整条链路。它主要解决三件事：

- **文档太大，不能整篇读**。单篇技术文档最大 258 KB，`AGENTS.md` 有 153 KB，整篇塞进上下文会把它挤爆。
  插件改成按关键词检索，只取需要的片段。
- **三端构建命令各不相同，而且都有坑**。API 端的 `.slnx` 是坏的，桌面端必须显式指定平台，Android 端不跑单元测试。
  这些直接内置成工具，顺带把实测可用的命令固化下来。
- **文档不会自己跟上代码**。新功能落地、BUG 修完，`docs/` 下的 md 就与代码出现偏差，而这个偏差是静默的 ——
  下一个会话读到的是过期事实。`kirara_docsync` 负责判断「这次改动该同步哪几篇、每篇改哪些章节」；
  反过来，纯文档改动（`mode=docs`）不参与编译，也就不该为它跑一次构建。

## 功能

| 工具 | 说明 |
| --- | --- |
| `kirara_start` | **入口**。给一句话需求，返回涉及哪几端、该先读哪几篇文档、各端构建命令、是否需要实机验证、有没有需要你拍板的问题。`mode=auto` 会在 `docs` / `full` / `small` 之间判定 |
| `kirara_profile` | 返回三端的项目画像：技术栈、构建/运行命令、硬约束。用来替代整篇读 `AGENTS.md` |
| `kirara_docs` | 在技术文档里按关键词检索，返回 `文件:行号` 和所属章节 |
| `kirara_route` | 把一句话需求展开成路线：涉及端、执行步骤、决策点 |
| `kirara_build` | 跑真实构建，返回成功与否、退出码、耗时、错误行、日志尾部 |
| `kirara_verify` | 产出分步的真机验收清单（步骤 + 预期结果）；传入截图路径可以额外拿到一段视觉复核协议，`purpose=ui-design` 时给的是「该怎么改」的 P0/P1 修改建议 |
| `kirara_docsync` | **文档同步**。自行判断本轮改动属于新功能 / BUG 修复 / 界面改动 / 纯内部整理，产出该更新的文档清单（哪几篇 + 哪些章节 + 逐条清单） |
| `kirara_summary` | 汇总本轮变更、构建结论、验证状态、**已同步的文档**、遗留风险 |

### 自动判断这轮要不要实机验证

`kirara_start` 的 `mode=auto` 先按 `full` 探一遍，命中下面任一条就保持 `full`：

- 请求涉及**用户可见的效果** —— 界面、渲染、布局、配色、图标、动画，或者评论、回复、@提及、
  通知、点赞这类交互功能
- 请求是**破坏性改动** —— 删除、下线、重构，或者数据库结构变更

都不命中才降为 `small`，也就是构建通过即完成。判定命中了哪条信号会随结果一起返回（`reasons` 字段），
误判时可以直接看出是哪条规则的问题。

这条规则刻意偏保守，因为两种误判的代价不对称：把可见功能误判成 `small` 会让人跳过实机验收直接发出去；
误判成 `full` 只是多走一遍清单。另外「构建通过」本身也只证明能编译，不证明效果对。


### 纯文档变更不跑构建（`mode=docs`）

改一篇 md 不需要编译 —— 产物和文档之间没有因果关系。`kirara_start` 的 `mode=auto` 会识别这类请求：

| 请求 | 判定 | 依据 |
| --- | --- | --- |
| 「同步一下文档」 | `docs` | 文档动作 + 文档对象 |
| 「更新 API 完整文档里的评论接口章节」 | `docs` | 有「章节」这类**文档结构词** ⇒ 接口是被描述的对象，不是要改的代码 |
| 「新增文档上传功能」 | `small`/`full` | 「新增」不在文档动作词表里 ⇒ 这是功能需求，照常构建 |
| 「修改文档上传逻辑」 | `small`/`full` | 「逻辑」是代码对象，且没有文档结构词 |

判定式是 `文档对象 ∧（文档动作 ∨ 文档结构词）∧（无代码对象 ∨ 文档结构词）`，命中即短路：
破坏性、表结构、实机验证三类决策对一篇 md 全都不适用，硬问下去只会产出噪声。
词表刻意**宁可漏判**（漏判只是多跑一次编译，误判会让人以为「构建都免了所以没问题」），
所以「改一下文档」这种没有结构词的短句不会自动命中 —— 需要时显式传 `mode=docs`。

`mode=docs` 下 `kirara_start` 的步骤只有四步（检索 → 编辑 md → 文档同步 → 收尾），
不给构建命令，`kirara_verify` 也会以 `skipped` 收场。

### 代码改完，文档也要跟上（`kirara_docsync`）

这是流程的常规一步：**构建验证 → 实机测试 → 文档同步 → 总结**。新功能和 BUG 修复都会改变对外行为，
所以文档同步不是「想起来才做」的附属动作。

```
kirara_docsync({
  feature: '评论支持 @ 提醒',
  changes: ['kirara_-server-api/Controllers/CommentsController.cs', 'kirara_server/Views/HomePage.xaml'],
})
```

它先给变化定性（`auto` 判定，可显式覆盖）：

| `kind` | 判定信号 | 文档要求 |
| --- | --- | --- |
| `feature` | 兜底（新功能、扩展、优化） | 必须同步 |
| `fix` | 修复 / 报错 / 崩溃 / 失效 / bug | 必须同步（描述旧行为的地方现在是错的） |
| `ui` | 界面 / 交互 / 社交功能词族 | 必须同步（界面契约变了） |
| `docs` | 文档动作 + 文档对象 | 本身就是文档工作 |
| `chore` | 格式化 / lint / 重命名变量 / 清死代码 | 不要求改正文，更新记录留一条即可 |

然后按「变化特征 → 文档」的规则表挑出该更新的文档（`docs/技术栈文档.md`、`Kirara Server API 完整文档.md`、
`需求文档.md`、`README.md`、`AGENTS.md` …），并读那几篇文档的标题，给出**具体章节**与逐条清单：

```text
📄 文档同步 [ui] —— 需更新 2 篇
判定: 界面/交互改动 —— 界面契约（入口、状态、主题）变了，需求/技术栈文档要跟上
目标:
  - kirara_-server-api/docs/Kirara Server API 完整文档.md
      章节: 三、评论系统 API (/api/comments) / 3.4 获取评论列表（分页） / 更新记录
      为什么: 接口/鉴权行为变化 ⇒ API 完整文档的对应章节 + 「更新记录」
清单:
  - ... → 改「三、评论系统 API (/api/comments) / 更新记录」
  - 逐篇核对文档里的命令 / 路径 / 版本号 / 端口 / 端点是否仍与代码一致
```

它只**判断与规划**，不替模型写文档 —— 真正的编辑仍由模型用 `write`/`edit` 完成。
判定为 `chore` 时它会明确说「不需要改正文」，所以这不是一个「每次都必须改点什么」的负担。

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
| 一个支持图像输入的 chat 模型路由 | `kirara_verify` 的截图复核。**UI 改动必须备**（不看图就别改样式）；非 UI 改动可以不备 |

只装插件、不备工具链也能用 `kirara_start` / `kirara_docs` / `kirara_route` / `kirara_docsync` 做路由、检索与文档同步。

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

返回里会给出涉及端、建议先读的文档、构建命令、是否需要实机验证，以及一条编号好的流程。按它给的步骤改完代码后：

```
kirara_build({ project: 'desktop' })          // 1) 构建
kirara_verify({ ... })                        // 2) full 时出实机清单；UI 改动带截图
kirara_docsync({ feature: '优化关键词检索排序', changes: [...] })   // 3) 判断该同步哪几篇文档
kirara_summary({ feature: '优化关键词检索排序', mode: 'small', changes: [...], docs: [...] })  // 4) 收尾
```

UI 改动的那一轮，第 2 步是 `purpose: 'ui-design'` + `screenshots`，见下文
[UI 改动必经截图复核](#ui-改动必经截图复核)；纯文档改动的 `mode=docs` 则会跳过第 1、2 步：
md 不参与编译，也没有可验的东西。

### 直接调用单个工具

跳过路由也可以，八个工具都能单独用：

```
kirara_profile({})                                 // 三端画像
kirara_profile({ project: 'api' })                 // 只看 API 端
kirara_docs({ keywords: ['MinIO', '预签名'] })      // 跨文档检索
kirara_docs({ keywords: ['评论'], project: 'api' }) // 限定单个子项目
kirara_build({ project: 'media' })                 // 构建 Android 端
kirara_verify({ summary: '设置页加暗色开关', project: 'media', mode: 'full' })
kirara_docsync({ feature: '评论支持 @ 提醒', changes: ['kirara_-server-api/Controllers/CommentsController.cs'] })
```

### UI 改动必经截图复核

这个项目不写单元测试，验证方式 = 构建 + 人工真机清单，人工清单由 `kirara_verify` 产出。
**界面/样式改动还要多一道**：不看截图就改配色和布局等于盲改，所以截图复核是 UI 开发的必经环节，
不是可选项。

两种 `purpose` 问的是不同的问题，别混：

| `purpose` | 问的问题 | 输出 |
| --- | --- | --- |
| `acceptance`（默认） | 这版**能不能发** | 逐张「通过 / 不通过 + 依据」 |
| `ui-design` | 这版**该怎么改** | 按 P0/P1/P2 分级、指名控件与数值的修改清单 |

```
kirara_verify({
  summary: '设置页加暗色开关',
  project: 'media',
  mode: 'full',
  purpose: 'ui-design',
  screenshots: ['D:/shots/settings-dark.png', 'D:/shots/settings-light.png'],
})
```

返回里会多出一段 `screenshotReview`，包含每张图的绝对路径、文件是否真实存在（插件会去 stat，
缺文件会标出来而不是静默跳过），以及一段可以直接执行的复核提示词。

`ui-design` 的提示词要求图像模型逐条给出：① 视觉层级与对齐不一致的元素（指名控件 + 建议数值）；
② 本次改动在截图里是否真的可见、是否破坏了原本正常的区域；③ 明显缺陷（截断、溢出、对比度、
缺图标、缺空态、深色主题下不可读）；④ 每条标 P0/P1/P2 并写成「改哪个文件或控件 → 改成什么」，
最后给一份可直接执行的修改清单。拿到清单后**改 P0/P1 → 在同一状态重截 → 再跑一次**，
直到没有 P0/P1 —— 收尾是循环，不是一次判定。

`acceptance` 的提示词固定问四件事：是否正常渲染（白屏 / 错位 / 乱码 / 占位图）、本次改动对应的
界面是否可见、有无明显异常（错误弹窗、缺失图标、对比度问题）、逐条给出通过或不通过的依据。
两种都明确要求不要臆测截图里看不到的内容。

**没给截图时不会静默放过**：只要 `summary` 命中界面/交互词族，或显式传了 `purpose=ui-design`，
返回值里就会出现 `needScreenshots`，明确要求先向用户索取实机截图，并禁止在拿到截图前宣称
「样式已经对齐」。这个兜底是机器化的 —— 不依赖模型记不记得 `purpose`。

插件自身不调用模型，只产出「怎么调」的协议 —— 实际的图像请求由模型按协议发起，
把每张图作为 attachment 发给支持图像输入的模型。这样插件保持无副作用、可以离线自检。

### 配置项

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `workspaceRoot` | `''` | 三端仓库的父目录。留空时依次回退到 `DSH_WORKSPACE`、当前工作目录 |
| `buildTimeoutMs` | `1200000` | 单次构建最长等待（20 分钟） |
| `buildLogTailLines` | `25` | 回传的日志尾部行数 |
| `buildLogLineChars` | `300` | 单条日志行的字符上限（NuGet/Gradle 单行可以上千字符） |
| `buildBudgetChars` | `5000` | `kirara_build` 单次返回的字符总预算；超出时先保 `errors`，再保日志尾部 |
| `docsMaxHits` | `12` | `kirara_docs` 默认返回的命中行数 |
| `docsLineChars` | `200` | `kirara_docs` 命中行的正文字符上限 |
| `docsBudgetChars` | `4000` | `kirara_docs` 单次返回的字符总预算 |
| `textBudgetChars` | `2400` | 叙述型工具（start/route/profile/verify/summary）单次返回的字符总预算。原为 1600，抬高的原因是 UI 设计复核协议**要被原样执行**，截断即失效 |
| `docsyncBudgetChars` | `2400` | `kirara_docsync` 单次返回的字符总预算 |
| `docsyncMaxTargets` | `4` | `kirara_docsync` 最多推荐几篇文档 |

### 前缀缓存与上下文预算（为什么输出压得这么小）

DSH 的请求按「最长相同前缀」复用 provider 的缓存。这个插件能影响到的只有两条路径，
两条都在 `scripts/cache-budget.mjs` 里被机器盯着：

**① 工具目录必须逐字节固定。** DSH 把 `request/header`（`config` + `tools` 的 JSON 快照）
记进会话；一旦装配出的工具集合与已记录的快照不等，`dsh-agent-loop` 就会开一条
**新的 request series**，而 `SystemPromptProjection.project()` 在开新 series 时会把
**对话最前面那条 system 消息原地改写**，而不是在尾部追加 —— 整段历史的前缀缓存当场作废。
所以工具名、`description`、`parameters` 全部是随进程启动固定的字面量，不含时间戳、
文件状态、环境变量或任何运行时探测结果，也不在运行期增删工具。

**② 返回值必须有硬预算。** 工具返回值会永久留在会话上下文里，上下文越大越早触到
`dsh-compaction-basic` 的压缩阈值；而一次 compaction 会重写历史头部（并从第一条非 system
消息开始），连带再次触发上面那条「原地改写系统节点」—— 于是整段前缀缓存又一次作废。
实测（2026-10；探针脚本 `cache-probe3.mjs`、`cache-probe5.mjs` 在 Kirara 工作区根目录的
`.dsh-debug/` 下，**不在本仓库内** —— 本仓库里长期盯着这条预算的是 `scripts/cache-budget.mjs`）：

- 单次 `kirara_docs` 曾返回 12.9–15.1 KB（默认 `maxHits` 40、每行 400 字符）
- 单次 `kirara_build` 曾返回 16.8 KB（60 行日志、无逐行上限）
- 在 69 万 token 的对话上，一次 compaction 让下一条请求的 `cacheRead` 从 ~67 万掉到 ~8.5 千
  —— 约 67 万 token 重算

所以现在：`kirara_docs` 默认 12 行 / 每行 200 字符 / 整体 4000 字符，`kirara_build` 默认
25 行 / 每行 300 字符 / 整体 5000 字符，超预算时明确告知模型「被截断了，请收窄查询」。
调大这些值等于主动换取更频繁的压缩与更低命中率 —— 真要调，请同时跑
`node scripts/cache-budget.mjs` 并同步改里面的预算基线。

工具目录本身也在预算内：8 个工具的 `name+description+parameters` 合计 **6496 字节**
（7 个工具时是 5061；新增 `kirara_docsync` 与 `purpose`/`docs` 参数带来的一次性常驻增量）。
这是一次性成本，换来的是「每轮都有人判断文档要不要跟上」，比事后返工便宜。基线卡在 6800 字节。

## 兼容性

`peerDependencies` 声明为 `@deepseek-ai/dsh-tools@^0.2.0-rc.2`，覆盖 DSH 0.2.x 全系列
（`0.2.0-rc.2` / `0.2.0` / `0.2.1` 均可用）。

`0.3.0` 起会被判 incompatible 并自动禁用。换大版本后如果仍想用，需要 `dsh plugin allow-version`
显式授权 —— 插件没有针对新版本测过，有崩溃风险。

## 升级

插件暂不支持自动更新。先在插件页卸载，再用新地址重装一次。

## 常见问题

**改一篇 md 也要我跑构建吗？**
不用。`mode=docs` 下 `kirara_start` 不给构建命令，`kirara_verify` 直接 `skipped`，
`kirara_summary` 的「构建验证」也写成「不适用：纯文档变更」。自动判定保守（漏判时显式传 `mode=docs`），
理由见[纯文档变更不跑构建](#纯文档变更不跑构建modedocs)。

**为什么改完 UI 它一直让我给截图？**
那是故意的。界面改动的验收标准是「看起来对不对」，而构建通过只证明能编译。
`kirara_verify` 只要发现 `summary` 命中界面/交互词族就会返回 `needScreenshots`，
要求先拿到实机截图；拿到图后用 `purpose: 'ui-design'` 换回一份 P0/P1 的修改清单。

**`kirara_docsync` 是不是每轮都得改文档？**
不是。它会先给变化定性：`chore`（格式化、lint、重命名变量、清死代码）明确返回「不需要改正文」；
`feature` / `fix` / `ui` 才要求同步，因为这三类改变了对外行为，而文档描述的是对外行为。

**装完在工具表里看不到 `kirara_*`？**
先确认插件已启用，然后**完全退出 DSH 再重启** —— 不是关窗口，也不是刷新页面，bundle 只在启动时读一次。
重启后请在**新会话**里验证：旧会话的历史消息里已经录下了加载失败时的工具快照，旧记录不会自动修复。

**启用这个插件之后缓存命中率变低了吗？**
这个问题被实测查过一遍（2026-10，探针脚本是工作区根目录 `.dsh-debug/cache-probe*.mjs`，
在本仓库之外），结论分三层：

1. **插件不会让工具目录抖动。** 同一会话里所有 `request/header` 的 `tools` 快照逐字节相同，
   `reason` 只有 `initial` / `series`，从未因工具变化出现 `change` —— 也就是说插件没有让 DSH 开新
   request series。（这也正是 `cache-budget.mjs` 要长期盯着的东西。）
2. **真正的损失来自 compaction 和轮次边界，都发生在核心。** 把「第 N 条请求的完整提示长度」
   当作第 N+1 条的理论命中上限，差额就是被重复计费的部分：在开了插件的长会话里，这部分占全部
   miss 的 39%–66%，归因区间事件是 `compaction/start…end`、`compaction/prune`、以及轮次边界的
   `agent/inbox/spliced`。机制上，这些事件都会让 DSH 开新 series，而
   `SystemPromptProjection.project()` 开新 series 时是**原地改写对话第一条 system 消息**，
   于是一次 compaction 就能让 69 万 token 的会话把 `cacheRead` 从 ~67 万打到 ~8.5 千。
3. **插件能做的只有「别把上下文推大」。** 实测它在全工具输出里占 5%–31%（单次 `kirara_docs`
   曾返回 12.9–15.1 KB，单次 `kirara_build` 曾 16.8 KB），而上下文越大越早触发上面第 2 条。
   本次修订就是压这个占比。

如果命中率仍然上不去，要查的是核心侧的两个旋钮而不是插件：
`dsh-compaction-basic` 的阈值 `thresholdTokens = min(contextWindow × 0.8, contextWindow − maxTokens − 65536)`
（默认 `thresholdRatio=0.8` / `retainRatio=0.16` / `headroomTokens=65536`，见 `dsh-compaction-basic/lib/index.js:15,17,63`），
以及每次开新 series 时对系统节点 0 的原地改写。

> 该旋钮已于 2026-10-10 修过一轮：`deepseek-flash` 官方规格是 context 1M / max output 384K，
> 而 `maxTokens` 原本跟着 DSH 默认值 `256000`（`dsh-llm-deepseek/lib/index.js:21`），
> 把阈值压到 678,464。现在 profile 里设成 `131072`（饱和点 134,464 以内），阈值顶到 **800,000**。
> 校验脚本：工作区根目录的 `.dsh-debug/verify-compaction-threshold.mjs`，公式反证：
> `.dsh-debug/cache-probe7.mjs`（两者都在本仓库之外）。

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

- [架构与项目画像](docs/architecture.md) —— 八个工具的实现、路由判定信号、文档同步规则、`PROJECTS` 常量怎么维护
- [DSH 插件契约](docs/plugin-contract.md) —— 插件要怎么写才会被 DSH 认可并加载
- [本地开发](docs/local-development.md) —— 挂载到 profile、部署脚本、五个自检夹具
- [故障排查](docs/troubleshooting.md) —— 怎么判断插件加载了没，以及几个已经踩过的坑

## 许可

MIT
