# dsh-plugin-kirara-dev

[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件，把 Kirara 三端项目
（`Kirara_Server_Studio` / `Kirara_Server-API` / `Kirara_Media`）的开发流程做成模型可以直接调用的工具。

> Kirara Dev Flow — route a request to the right projects, search the docs, run the real build,
> then hand over a device-acceptance checklist.

装好之后模型手里会多出十一个 `kirara_*` 工具，覆盖「读文档 → 定路线 → 改代码 → 跑构建 → 出验收清单 →
同步文档 → 发布 → 收尾」这整条链路，外加一条「把改代码与视觉迭代交给外部强模型」的交接链路。
它主要解决五件事：

- **文档太大，不能整篇读**。单篇技术文档最大 258 KB，整篇塞进上下文会把它挤爆。
  插件改成按关键词检索，只取需要的片段。
- **三端构建命令各不相同，而且都有坑**。API 端的 `.slnx` 是坏的，桌面端必须显式指定平台，Android 端不跑单元测试。
  这些直接内置成工具，顺带把实测可用的命令固化下来。
- **文档不会自己跟上代码**。新功能落地、BUG 修完，`docs/` 下的 md 就与代码出现偏差，而这个偏差是静默的 ——
  下一个会话读到的是过期事实。`kirara_docsync` 负责判断「这次改动该同步哪几篇、每篇改哪些章节」；
  反过来，纯文档改动（`mode=docs`）不参与编译，也就不该为它跑一次构建。
- **发布是拼命令，而且出错之后改不回来**。三端的打包脚本、版本号来源、产物命名、校验码格式各不相同，
  还要在发出去之前把新增功能写进给用户看的 README。`kirara_release` 把这些固化成工具：
  产物统一按 `_v<版本>` 命名搬到桌面、生成 `sha256sum` 格式的校验文件、README 没跟上就直接拦下。
- **改代码也可以交给外部强模型，但事实不能靠聊天记录转述**。同一个需求在两次转述之间会走形，
  而「改代码 + 跑构建 + 用 MCP 盯着界面改」这一段本来就该由拿得到 MCP 的那个智能体做。
  `kirara_handoff` 把需求、边界、约束、文档线索、验收标准与回执契约落成一份文件，
  外部模型干完再回一份结构化回执 —— 两边只交换文件，不交换回忆。

## 功能

| 工具 | 说明 |
| --- | --- |
| `kirara_start` | **入口**。给一句话需求，返回涉及哪几端、该先读哪几篇文档、各端构建命令、是否需要实机验证、有没有需要你拍板的问题。`mode=auto` 会在 `docs` / `full` / `small` 之间判定；`detail=route` 只出路线（原 `kirara_route`，此时 `mode` 必须显式给） |
| `kirara_profile` | 返回三端的项目画像：技术栈、构建/运行命令、硬约束。用来替代整篇读那些几百 KB 的技术文档。顺带做一次**死链自检**：`PROJECTS` 里登记了但磁盘上不存在的文档路径会在末尾以 `⚠️ 失效文档路径（n）` 列出（都正常时这一行不出现，零成本） |
| `kirara_docs` | **分章文档检索**。`mode=map` 先看章节地图（章 / 小节 / 显式锚点 / 结构审计），`mode=search` 按关键词返回 `文件:行号` + 所属章/节/锚点，`mode=section` 用 `03.2` 或 `#auth` 只读单节 |
| `kirara_handoff` | **外部强模型交接**。`action=open`（`executor=file` 默认给交接目录里的 brief，`executor=chat` 把 brief 正文直接塞进返回值）落下 brief（九节）/ `prompt.md` / `shots/` 并给出可粘贴的 prompt；`action=close` 校验外部回执、写 `report.md` + `report.json`，回出 `changed[]` 喂给 `kirara_docsync`，可选用 `verifyBuild=stat/rerun` 把回执自述与磁盘/复跑结果对一遍。不发网络请求、不轮询、不执行回执里的任何字符串 |
| `kirara_build` | 跑真实构建，返回成功与否、退出码、耗时、错误行、日志尾部。media 是双端，`target` 可选 `android` / `ios-klib` / `ios-framework` / `ios`（`ios` 会跑模拟器自检并直接产出 UI 截图） |
| `kirara_verify` | 产出分步的真机验收清单（步骤 + 预期结果）；传入截图路径可以额外拿到一段视觉复核协议，`purpose=ui-design` 时给的是「该怎么改」的 P0/P1 修改建议 |
| `kirara_docsync` | **文档同步**。自行判断本轮改动属于新功能 / BUG 修复 / 界面改动 / 纯内部整理，按 `frontmatter.files` + 标题关键词选章、选节，产出**插入位置**（改哪节，或在第几行新增 `## NN.M` + 锚点）、frontmatter 补文件、99 变更记录条目与写作规范 |
| `kirara_release_notes` | **发布素材**。取「上个版本 tag → HEAD」的全部提交，按「新增功能 / 修复 / 内部整理 / 需人工判断」分好桶，并核验 README 是否跟上本轮 |
| `kirara_release` | **发布**。跑仓库自带的发布脚本（api 走技术栈文档里的 docker 命令）打包，产物按 `_v<版本>` 命名搬到桌面，生成 SHA256 校验文件。`dryRun` 只出计划 |
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

### 分章技术栈文档：先看地图，再读单节

2026-11 起，技术栈文档从「一篇 258 KB 的大 md」改成按模块分章（`Kirara_Server_Studio` 已落地，
`Kirara_Media` 正在迁移）：

```text
Kirara_Server_Studio/docs/技术栈文档/
├── 01-总览与架构.md          # frontmatter: module / level / files / related
├── 02-启动与外壳.md          # # 02 启动与外壳
│                             #   <a id="shell-page"></a>
│                             #   ## 02.2 ShellPage 架构
├── …
├── 14-附录-清单总表.md
└── 99-变更记录.md            # 只写流水，日期倒序
```

这种结构对 AI 检索的价值在**两层导航**：先拿到「有哪几章、每章有哪些节、每节的稳定锚点」，
再只读一个小节；而不是把整篇文档塞进上下文。`kirara_docs` 因此有三种模式：

| 模式 | 用途 | 返回 |
| --- | --- | --- |
| `mode=map`（不确定先看这个） | 章节目录 + 每章前几个小节 + 锚点；`chapter: '03'` 展开该章全部小节与行号 | 章 / 节 / 锚点 / 结构审计 |
| `mode=search`（默认） | 关键词命中行 | `文件:行号` + 所属章 + 小节（`03.2 账号设置`）+ 锚点 |
| `mode=section` | 只读一节 | `section: '03.2'`、`'auth'` 或标题片段；返回该节正文与行范围 |

检索不是「全文 grep + 行号」：命中行会按「章标题 / 小节标题 / frontmatter.files / 正文」加权，
所以问「登录」时 `03.1 认证系统` 的正文会排在 99 变更记录的历史条目之前；`99` 只作为历史证据降权。

**发现规则不写死路径**：任何项目下 `docs/` 或 `app/docs/` 里，只要某个目录同时有 ≥2 个
`NN-标题.md`（01–89），就自动当成一个分章文档集。所以新增项目 / 新增章节不需要改插件；
`PROJECTS` 里仍要登记该端的仓库目录与 `techDocs`（或让它按 `docs` 目录自动发现）。
结构约定与插入模板见 [分章文档写作规范](docs/doc-conventions.md)。

`mode=map` 末尾还会带**结构审计**：缺 frontmatter、`##` 未编号、锚点重复、跨文档断链、
`related` 指向不存在的文件。这些是「下一轮 AI 会读错/写错」的硬伤，不是排版洁癖。

### 代码改完，文档也要跟上（`kirara_docsync`）

这是流程的常规一步：**构建验证 → 实机测试 → 文档同步 → 总结**。新功能和 BUG 修复都会改变对外行为，
所以文档同步不是「想起来才做」的附属动作。

```
kirara_docsync({
  feature: '评论支持 @ 提醒',
  changes: ['Kirara_Server-API/Controllers/CommentsController.cs', 'Kirara_Server_Studio/Views/HomePage.xaml'],
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

然后按「变化特征 → 文档」的规则表挑出该更新的文档。分章文档集走另一条更精确的路：

1. **改动路径 → 章**：`frontmatter.files` 里的 `Services/RemoteCommentService.cs` 命中 `11-社区与内容.md`；
   `Views/Comment/CommentPanel.xaml` 命中同一章。路径匹配（含 `Views/Page.xaml(.cs)` 这种成对写法）是强信号。
2. **标题/小节关键词 → 章与节**：没有路径命中时，用 feature 词与 01–99 的章标题、`##` 小节标题比对。
3. **给插入计划**：命中既有小节 ⇒ 改哪一节（行号）；没有 ⇒ 在章末新增 `## NN.(M+1)`，
   并给出建议锚点、插入行号；**BUG 修复不新开小节**（修的是旧描述，落点是改写既有段落，流水只进 99）。
4. **补 frontmatter.files**：本次改到的源文件若不在该章 `files:` 里，会列出来。
5. **99 变更记录**：单卷 99 ⇒ 在引言后插入 `## YYYY-MM-DD · 标题`；多卷 99（`99-变更记录/01…卷`）
   ⇒ 追加到**最新卷**末尾，编号取所有卷历史条目最大值 +1，并提示同步 `00-索引与编号映射.md`。

真实输出（节选）：

```text
📄 文档同步 [ui] —— 需更新 2 篇
判定: 界面/交互改动 —— 界面契约（入口、状态、主题）变了，技术栈文档要跟上
目标:
  - Kirara_Server_Studio/docs/技术栈文档/11-社区与内容.md  [11 社区与内容]
      改「11.1 议题评论」
      为什么: 功能 / 交互行为变化 ⇒ 技术栈文档的落地记录章节
  - Kirara_Server_Studio/docs/技术栈文档/99-变更记录.md
      在引言之后、最新条目之前（第 5 行后）插入「## 2026-11-16 · 新增评论 @ 提醒功能」+ 一条变更点
写法:
  - 章节文件 `NN-标题.md`：新增模块取下一个空号；H1 用 `# NN 标题`；frontmatter 写 module / level / files / related。
  - 小节 `## NN.M 标题`，编号在本章内连续；标题前一行加 `<a id="slug"></a>`；跨文档链接只认显式锚点。
  - 正文只写稳定结论；本轮改了什么只进 99 变更记录，正文不写「本轮」。
```

它只**判断与规划**，不替模型写文档 —— 真正的编辑仍由模型用 `write`/`edit` 完成。
判定为 `chore` 时它会明确说「不需要改正文」，所以这不是一个「每次都必须改点什么」的负担。


### 发布（`kirara_release`）

发布是这个插件里**唯一有不可逆副作用**的动作：产物发出去之后改不回来。三端的发布现实各不相同，
所以插件不发明统一流程，而是把每一端**已经在用的**那套固化下来：

| 端 | 打包方式 | 版本号来源 | 递增 |
| --- | --- | --- | --- |
| desktop | 仓库自带的 `tools/publish_all.ps1`（编译出固定文件名的 Inno Setup 安装包） | `installer/Kirara_Server_Setup.iss` 与 `Kirara_Server_Studio.csproj`，两处必须一致 | 不自动递增（重新打包当前版本） |
| media | 仓库自带的 `tools/build_release.ps1 -Version <v>` | `app/build.gradle.kts` 的 `versionName` | 不自动递增 |
| api | 技术栈文档 §13.0 的 `docker build` + `docker save` | 技术栈文档里最大的 `kirara-api:X.Y.Z` | **自动 +1（patch）** |

发布前先取素材：

```
kirara_release_notes({ project: 'media' })   // 上个版本 tag → HEAD 的全部提交，按桶分好
```

它做的是**机械分桶**，不是替你写作：约定式前缀（`feat`）与「新增/支持/实现」进「新增功能」，
「修复/修正/崩溃/失效」进「修复」，格式化与 lint 进「内部整理」，拿不准的一律进「需人工判断」。
判定顺序是刻意的 —— **约定式前缀优先于关键词**，因为实测里有这样的提交标题：

```text
feat(应用内更新): 应用内 APK 下载/校验/安装，并修正互动预览（0.9.7-beta）
```

它同时含 `feat` 和「修正」。按关键词判会被丢进「修复」桶，于是这个功能在给用户看的 README 里
凭空消失 —— 而这正是最不该发生的一类错误：漏掉的功能没人会去补。另外，区间内**重复的标题会被折叠**
（合过分支的仓库里，同一条提交会经另一条父链再次进入历史；实测后端仓库 65 条里有 20 条是这种），
折叠了几条会明说。

拿到素材后写 README，再发布：

```
kirara_release({ project: 'media' })             // 真发布
kirara_release({ project: 'api', dryRun: true }) // 只看计划，什么都不做
```

`dryRun` 会给出完整步骤表、解析出的版本号、以及**所有前置条件是否满足**。真发布时按端做这些事：

- **desktop**：跑 `publish_all.ps1` → 在 `bin/installer` 里按正则找产物 → 复制并重命名为
  `Kirara_Server_Studio_Setup_x64_v<版本>.exe` → 落到桌面 → 生成同名 `.sha256`
- **media**：跑 `build_release.ps1`（脚本自己就会输出到桌面并写好 `.sha256`）→ 插件**核验**产物
  与校验码一致；脚本没留校验码就补写。**脚本没按版本号命名时，插件会补 `_v<版本>` 后缀** ——
  找出本次新产生或被改写的候选产物，唯一才改名（同时改写校验码正文里的文件名，
  否则 `sha256sum -c` 会永远验不过），候选不止一个就拒绝猜测
- **api**：`dotnet build` 预检 → `docker build -t kirara-api:<版本> -t kirara-api:latest .`
  → `docker save` 两个 tag → 导出为 `kirara-api-<版本>.tar` 落到桌面 → 生成同名 `.sha256`

三个细节是有意为之的：

- **api 的 tar 必须同时含 `latest` tag**。`docker-compose.yml` 引用的是 `kirara-api:latest`，
  只导出带版本号的 tag，部署方拉起来会发现镜像不存在。
- **校验码是 `sha256sum` 格式**（`<hash> *<文件名>`，无 BOM）。有 BOM 时 `sha256sum -c` 直接解析
  失败 —— 一个「有校验文件但验不了」的产物比没有校验文件更糟。
- **media 的校验码不是照抄脚本给的**：脚本产出的哈希会被重新计算比对，对不上就判失败。
  照单全收等于把校验这一步变成装饰。

#### 发布前的 README 门禁

用户看到的是 README，不是提交日志。所以发布前插件会检查每篇 README 是否跟上了本轮：

| 判定 | 含义 | 结果 |
| --- | --- | --- |
| `ok` | 已含本版本号，或自上个版本以来被改动过 | 放行 |
| `stale` | 明明白白写着**上一个**版本号 | **拦下** |
| `unchanged` | 被 git 跟踪，但自上个版本以来一次都没改过 | **拦下** |
| `missing` | 发布画像里列了却找不到文件 | **拦下** |
| `unverifiable` | 既不写版本号，又没有可用的 git 证据 | 只提醒 |

为什么需要 `unchanged` 这一级：desktop 与 media 的默认行为是**版本号不变、重新打包**，
只靠「README 里有没有这个版本号」会平凡通过 —— 那个号可能上个迭代就写进去了，完全不能证明
本轮的新增功能被写了进去。而「自上个版本以来 README 被改过没有」是不能平凡满足的证据，
正好对上「发布前必须把新增功能写进 README」这条硬要求。反过来，从不写版本号的 README
（`Kirara_Media` 就是）在证据不足时只提醒、不误拦 —— 一个永远拦人的门禁等于没有门禁，
人只会习惯性加 `force`。

拦下时 `force: true` 可以放行，但回传里会留下「已被 `force` 跳过」的痕迹，不会被静默吞掉。

### 内置的构建命令

| 端 | 仓库目录 | 构建命令 |
| --- | --- | --- |
| desktop | `Kirara_Server_Studio` | `dotnet build Kirara_Server_Studio.slnx -c Debug -p:Platform=x64 --nologo` |
| api | `Kirara_Server-API` | `dotnet build Kirara_Server-API.Server/Kirara_Server-API.Server.csproj -c Debug --nologo` |
| media（Android） | `Kirara_Media` | `gradlew.bat assembleDebug --console=plain` |
| media（iOS） | `Kirara_Media` | macOS：`./gradlew :shared:compileKotlinIos*` → `linkDebugFrameworkIos*` → `bash iosApp/run-simulator.sh`；Windows 只有第一步（klib） |

`kirara_build` 在 DSH 宿主进程里执行，因此不受 PowerShell 沙箱的 stdio 限制，也不占用工具调用超时。
默认单次构建最长等 20 分钟，够 Gradle 冷启动。

#### media 是双端：`target` 决定跑哪条链

`Kirara_Media` 是 **Android + iOS 双端**：`:shared` 是 Kotlin Multiplatform 的共享 UI（Compose
Multiplatform），`iosApp/` 是 SwiftUI 薄壳。两端的工具链**不在同一台机器上**，这是本项目最容易
踩错的一条：

| 能跑什么 | Windows | macOS（Apple Silicon） |
| --- | --- | --- |
| Android `assembleDebug` | ✅ | ⚠️ macOS 上没装 Android SDK，会失败 |
| iOS klib（`:shared:compileKotlinIos*`） | ✅ | ✅ |
| 链接 `shared.framework` | ❌ | ✅ |
| Xcode 出包 / 模拟器自检 + 截图 | ❌ | ✅ |

所以 media 的 `kirara_build` 多了一个 `target`：

| `target` | 实际跑什么 | 哪台机器能跑 |
| --- | --- | --- |
| `auto`（默认） | macOS → `ios`；Windows → `android` | — |
| `android` | `gradlew.bat assembleDebug --console=plain` | Windows |
| `ios-klib` | `:shared:compileKotlinIosArm64 :shared:compileKotlinIosSimulatorArm64` | **两边都行**（最快的 iOS 门禁） |
| `ios-framework` | `linkDebugFrameworkIosSimulatorArm64 :shared:linkDebugFrameworkIosArm64` | 仅 macOS |
| `ios` | `bash iosApp/run-simulator.sh`：构建 → 装模拟器 → 启动 → 截图 → ✅/❌ | 仅 macOS |

在 Windows 上请求后两个，插件**不会假装跑过**：它退化成 klib 门禁，把要在 Mac 上执行的命令放进
`macCommands`，`ok` 只代表 klib 的结果，`note` 里会写明「链接/出包/模拟器必须在 macOS」。

#### iOS 的 UI 验证是闭环的：`target=ios` 直接产出截图

iOS 的验证靠**模拟器 + 截图**（这台 Mac 上没有 `Simulator.app` —— 模拟器 GUI 是 Xcode 27 的
`DeviceHub.app`，可复现的取证只走 `simctl`）。`iosApp/run-simulator.sh` 已经把整条链固定下来，
插件把它接成一步：

```
kirara_build({ project: 'media', target: 'ios' })
  → screenshots: [.../01-login.png, 02-logged-in.png, 03-wkwebview.png]
  → 直接把这几条绝对路径喂给
kirara_verify({ summary, project: 'media', mode: 'full', purpose: 'ui-design', screenshots: [...] })
  → 拿 P0/P1 清单 → 改代码 → 再 target=ios 重截 → 再复核
```

脚本会默认打开端到端自检与 T4（`KIRARA_IOS_SELFTEST=1 KIRARA_IOS_T4=1`，诊断浮层关闭），
因为只截一张登录页不足以证明「改动在界面上可见」。

`simctl` 不能打字、也不能点击，所以**键盘 / IME / 手动登录**这类只能开 DeviceHub 人肉复核 ——
清单里会明确写出这一条，不要用「构建通过」代替。完整的 Mac 环境（Xcode 27.2 / iOS 27.2 运行时 /
JDK 位置）与九条「静默失败」的坑点见
`Kirara_Media/app/docs/Kirara Media iOS P0 Mac 执行清单.md`（§7 已知提示、§9.7 DeviceHub、
§10–§11 主仓构建与验收）；`kirara_profile({ project: 'media' })` 会给出其中三条最关键的。

## 前置条件

这个插件是**薄编排层**，本身不含任何 Kirara 代码。要真正用起来，你需要先有 Kirara 三端仓库本身：

| 需要 | 用于 |
| --- | --- |
| DSH 0.2.x | 插件运行环境 |
| Kirara 三端仓库（至少你关心那一端） | 被编排的对象 |
| .NET 10 SDK + WinUI 3 工作负载 | `kirara_build` 构建 desktop |
| JDK 17 + Android SDK | `kirara_build` 构建 media 的 Android 端（`target=android`） |
| macOS + Xcode（Apple Silicon） | media 的 iOS 端：`target=ios-klib` 在 Windows 也能跑，但 `ios-framework` / `ios` 必须有 Mac。Mac 上**不需要** Android SDK |
| Docker Desktop（且**正在运行**） | `kirara_release` 发布 api：`docker build` / `docker save` 都要它。没启动时发布会被前置检查拦下，而不是跑到一半失败 |
| Inno Setup 6（`ISCC.exe`） | desktop 的发布脚本编译安装包 |
| `Kirara_Media/keystore.properties` | media 的 release 签名。缺失时发布会被签名前置检查拦下 |

只装插件、不备工具链也能用 `kirara_start` / `kirara_docs` / `kirara_docsync` / `kirara_handoff` 做路由、检索、文档同步与外部交接。

## 安装

插件通过 **DSH 插件管理**安装 —— 不需要手工编辑 profile 的 JSON：DSH 会把它写进
`dsh.profile.bundles`，并用 pnpm 把依赖物化到 `profiles/<profile>/node_modules`。

GUI 入口：侧栏 **插件** → **添加插件** → 粘贴获取地址。
命令行等价物：`dsh plugin --profile <profile> add <spec>`。

### 1. 选获取方式

只认下面四种写法，**推荐第 1 种**：

| # | 写法 | 需要 git / SSH key | 适用场景 |
| --- | --- | --- | --- |
| 1 | `git+https://github.com/akeno6388/dsh-plugin-kirara-dev.git#<40 位 commit sha>` | **不需要** —— pnpm 直接下 codeload 压缩包 | **推荐**：给别人的机器装，或要可复现的版本 |
| 2 | `git+https://github.com/akeno6388/dsh-plugin-kirara-dev.git#main` | 需要 —— 先 `git ls-remote` 解析「分支现在指向哪个 commit」 | 自己的机器，想一直跟最新 |
| 3 | `file:<绝对路径>` / `link:<绝对路径>` | 不需要 | 本地开发，改完源码立刻生效 |
| 4 | `@kirara/dsh-plugin-kirara-dev` | — | 发布到 npm 之后（尚未发布） |

**推荐写法 —— 钉 commit：**

```powershell
git ls-remote https://github.com/akeno6388/dsh-plugin-kirara-dev.git refs/heads/main
# 把回显里的 40 位 sha 填进下面这行
```

```
git+https://github.com/akeno6388/dsh-plugin-kirara-dev.git#<40 位 sha>
```

钉 commit 的好处：本机**不需要** git、也不需要 SSH key，而且同一串 sha 在任何机器上都得到同一份代码。

#### 跟 `main`：先掰掉 ssh

写分支名时，pnpm 会用 hosted-git-info 把 GitHub 地址规范化成 `git+ssh://git@github.com/…` ——
**无论你写的是 `github:owner/repo` 简写还是完整的 `git+https://`**。没配 GitHub SSH key 的机器直接
`Host key verification failed`。先加这两条 git 配置，把 ssh 掰回 https（前缀很窄，只匹配 pnpm 生成的
这种 URL，不影响平时 `git@github.com:owner/repo` 的用法）：

```powershell
git config --global --add 'url.https://github.com/.insteadOf' 'git+ssh://git@github.com/'
git config --global --add 'url.https://github.com/.insteadOf' 'ssh://git@github.com/'
```

⚠️ 必须用 `--add`：同一个 key 写两次，第二次会**覆盖**第一次而不是并存。

GitHub 的 443 时通时断，`git ls-remote` 偶发超时（实测同一条命令 2 秒通、21 秒超时都出现过），
重试一次通常就好；长期不通再考虑换 Gitee 镜像地址。

### 2. 启用

安装完成界面点 **立即启用**，或回到插件列表打开该组合包的开关。

**首次登记必须完全重启 DSH** —— 不是关窗口，也不是刷新页面：`dsh.profile.bundles` 只在启动时
读一次，运行中的进程不会感知。重启后请**开新会话**验证（旧会话已经录下了旧版本的工具快照）。
登记过之后，插件列表里的开关就是运行时的了 —— 打开 / 关掉当帧生效，不必再重启。

### 3. 指向你的仓库

插件按 `DSH_WORKSPACE` → 当前工作目录的顺序推测 Kirara 仓库根目录，也就是三端仓库的**父目录**。
⚠️ Electron 桌面端启动时当前工作目录常常是 **profile 目录**（如 `…/profiles/desktop-017`），这条回退基本猜不中，
所以桌面端建议**显式配置** —— 在自己 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: kirara-dev
  config:
    workspaceRoot: 'D:\path\to\your\kirara-root'
```

配置是**整行替换**，没写的字段会回落到插件内置默认值。改完要**完全重启 DSH** —— bundle 只在启动时读一次。

装完用 `kirara_profile({})` 验证：回传里的 `workspaceRoot` 与 `缺失目录` 会直接暴露指错的情况。

### 4. 卸载

在插件页移除该插件，DSH 会同时清掉 `dependencies` 与 `dsh.profile.bundles` 里的条目；
之后**完全重启 DSH**。

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

跳过路由也可以，十一个工具都能单独用：

```
kirara_profile({})                                 // 三端画像
kirara_profile({ project: 'api' })                 // 只看 API 端
kirara_docs({ mode: 'map', project: 'desktop' })      // 先看章节地图（含结构审计）
kirara_docs({ mode: 'map', project: 'desktop', chapter: '03' }) // 展开 03 章的小节与行号
kirara_docs({ keywords: ['MinIO', '预签名'] })      // 跨文档检索
kirara_docs({ keywords: ['评论'], project: 'api' }) // 限定单个子项目
kirara_docs({ mode: 'section', project: 'desktop', section: 'auth' }) // 只读 03.1（按锚点）
kirara_docs({ mode: 'section', project: 'desktop', section: '03.2' }) // 按 NN.M 读单节
kirara_build({ project: 'media' })                 // Android 端（Windows 默认）
kirara_build({ project: 'media', target: 'ios' })   // iOS：模拟器自检 + 截图（仅 macOS）
kirara_build({ project: 'media', target: 'ios-klib' })  // iOS 侧最快门禁（Windows 也能跑）
kirara_ui({ action: 'plan', platform: 'ios' })         // 实时视觉环：发现 MCP/设备，给出这一轮怎么转
kirara_ui({ action: 'shot', platform: 'ios' })           // 截一张进编号证据，拿路径去 read_image
kirara_ui({ action: 'shot', paths: ['/abs/mcp-shot.png'] })  // 采纳 Xcode MCP 回传的截图
kirara_ui({ action: 'review', issues: ['卡片圆角 18 → 14'] }) // 记一轮迭代；issues 清空才算闭环
kirara_ui({ action: 'status' })                          // 这一轮到底看过没有（verify/summary 也读它）
kirara_verify({ summary: '设置页加暗色开关', project: 'media', mode: 'full' })
kirara_docsync({ feature: '评论支持 @ 提醒', changes: ['Kirara_Server-API/Controllers/CommentsController.cs'] })
kirara_release_notes({ project: 'api' })            // 发布素材（后端没有版本 tag ⇒ 自动退回首提交）
kirara_release_notes({ project: 'media', from: 'v0.9.6-beta' })  // 显式收窄区间
kirara_release({ project: 'desktop', dryRun: true })  // 发布计划：步骤 + 版本号 + 前置条件
kirara_release({ project: 'media' })                  // 真发布（跑脚本、搬桌面、写校验码）
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

**iOS 侧不走「向用户要图」这条路**：`summary` 命中 iOS 词族（或本机是 macOS）时，
`needScreenshots` 会改成「先去跑 `kirara_build({ project: 'media', target: 'ios' })`」——
模拟器自检本来就会出图，让用户手截一遍纯属倒退。在 Windows 上则会明确写「必须交接给 Mac」，
不允许拿「构建通过」顶替看图。

插件自身不调用模型，只产出「怎么调」的协议 —— 实际的图像请求由模型按协议发起，
把每张图作为 attachment 发给支持图像输入的模型。这样插件保持无副作用、可以离线自检。

### 实时视觉迭代环（`kirara_ui`）

截图复核解决的是「改完有没有人看过」，但它仍然发生在**整条自检链路之后**：改代码 → 跑全量自检
（约 4 分钟）→ 出 4 张固定截图 → 看着返工。所以 2026-11 起 UI 的内环换成 `kirara_ui`：

```
kirara_ui({ action: 'plan', platform: 'ios' })   // ① 先看这台机器上到底有什么可用
kirara_ui({ action: 'shot' })                    // ② 截一张（几秒），read_image 真正看图
kirara_ui({ action: 'review', issues: [...] })   // ③ 把要改的记成一轮
kirara_build({ project: 'media', target: 'ios' }) // ④ 增量构建 → 回 ②
kirara_ui({ action: 'review' })                  // ⑤ issues 清空 = 闭环，才允许收尾
```

三件事是它刻意做的：

**① 先发现，再调用。** `action: 'plan'` 会读宿主**当前真实可用**的工具名
（`ctx.tools.definitions()`），认出哪些 MCP 命名空间能截图 / 点按 / 出 UI 树 / 渲染预览，
并把可执行的调用序列写出来。工具描述本身保持字面量（前缀缓存契约），探测结果只出现在返回值里。
本机实测：

```
MCP:
  xcode（36 个工具）: 点按/输入=mcp__xcode__DeviceInteractionSynthesize | 预览=mcp__xcode__RenderPreview | 装/启=mcp__xcode__DeviceInteractionInstallAndRun
预览快通道: mcp__xcode__RenderPreview（只覆盖 SwiftUI 壳；:shared 的 Compose UI 仍要走 1–4）
```

这一步同时补上了长期缺口：`simctl` 不能点也不能打字（P0 清单 §9.7），
而 Xcode MCP 的 `DeviceInteractionSynthesize` 能在模拟器上点按/输入并回传截图 + UI 层级，
于是「先走到目标界面再截图」在 iOS 上终于可以自动完成。

**② 没 MCP 也不停摆。** 截图有兜底桥：iOS 走 `xcrun simctl io <udid> screenshot`，
Android 走 `adb exec-out screencap -p`（二进制管道，不走字符串解码，否则拿到的是坏图）。
发现不到任何 MCP 时照样出图，只是少了「点按/输入」这一段。

**③ 闭环是「事实」，不是自述。** 每张截图按 `shot-NN.png` 编号进
`<Kirara_Media>/iosApp/.tmp/ui-loop/`（该目录在 media 的 `.gitignore` 里整棵忽略），
状态记在 `state.json`。`kirara_verify` 在视觉环未闭环时会多给一步「先 status 看差什么」，
`kirara_summary` 会把未闭环写进**遗留风险**。于是「改了界面但没人看过」这件事从
「靠模型自觉」变成「工具会点名」。

Android 侧要同样的能力，需要一台跑得起来的设备（真机开 USB 调试，或装 emulator 组件 + 建 AVD），
以及一个设备控制类 MCP。插件可以代你注册（托管给 `ctx.mcpManager`，插件卸载即摘除）：

```yaml
- id: kirara-dev
  config:
    uiMcpServer: android          # 工具名会是 mcp__android__*
    uiMcpCommand: /Users/you/.local/bin/adb-mcp
    uiMcpArgs: '--sdk /Users/you/Library/Android/sdk'
```

没配就什么都不做（本机没有 npm/npx，自动下载第三方服务器不是插件的职责）。
即便不配 MCP，Android 的截图与 `adb shell input tap` 也照常可用。

### 与外部强模型交接（`kirara_handoff`）

分工可以是这样的：**DSH 负责「读懂 + 定路线 + 检索文档 + 收回执 + 同步文档 + 发版」，
外部强模型（带 MCP 的编码智能体）负责「改代码 + 跑构建 + 用 MCP 实时看界面 + 自验收」**。

问题是这两者不共享上下文：把需求用聊天记录转述过去，第二次转述就和第一次不一样了；
把「哪些端、什么约束、读过哪几段文档、怎么算验收通过」也靠嘴说，等于让外部模型猜。
所以 `kirara_handoff` 把这段交接**落成文件**：

```text
<workspaceRoot>/.kirara-dev/handoff/KH-20261127-1807/
├── brief.md      # 九节交接包（人读）：任务卡 / 边界 / 涉及端 / 必读事实 / 文档线索 /
│                 #   文档片段 / 验收标准 / MCP 用法 / 回执格式
├── brief.json    # 机读的同一份（含 targets / docHits / safety / checklist）
├── prompt.md     # 可直接粘贴给外部模型的那段话（约 900 字）
├── shots/        # 外部模型的截图写这里 —— 两边都能看到的唯一证据目录
├── report.md     # close 时写入（回执原文）
├── report.json   # close 时写入（解析 + 校验后的结构）
└── README.txt    # 一行说明：这是 DSH 与外部模型之间的交接目录
```

一次完整交互长这样：

```js
// ① DSH 侧：产出交接包（inline=false 时只回路径 + 可粘贴的 prompt，≤ 2400 字符）
kirara_handoff({ action: 'open', request: '设置页加暗色开关' })
// → { runId: 'KH-20261127-1807', dir, briefPath, promptPath, prompt, mode: 'full',
//     targets: [...], checklist: [...], safety: [...] }

// ② 人把 prompt.md（或返回值里的粘贴块）交给外部模型；
//    它读 brief.md → 改代码 → 跑构建 → 截图进 shots/ → 按第 9 节的 JSON 模板回执

// ③ DSH 侧：收回执。缺 status / summary / changed 会被拒收且**不写** report.json
kirara_handoff({ action: 'close', runId: 'KH-20261127-1807', report: '<外部回执原文>' })
// → { status: 'done', summary, changed: ['Kirara_Media/.../SettingsScreen.kt'],
//     commands, screenshots, verification, docsHint, openIssues, nextStep }

// ④ 回执里的 changed 直接喂文档同步，再写、再总结
kirara_docsync({ feature: '设置页加暗色开关', changes: ['Kirara_Media/.../SettingsScreen.kt'] })
kirara_summary({ feature: '设置页加暗色开关', mode: 'full', changes: [...] })
```

#### 两个投递/校验参数（0.4.1）

外部模型分两种：**能读本地文件的**（IDE / CLI 里的编码智能体）和**只在聊天框里的**。
回执也分两种：**真跑过构建的**和**只是这么写的**。两个参数各管一头：

| 参数 | 取值 | 做什么 |
| --- | --- | --- |
| `executor`（`open`） | `file`（默认） | 现状：`prompt.md` 只给交接目录与 `brief.md` 的绝对路径，正文在文件里 |
| | `chat` | 把 brief 正文**整段嵌进返回值**（等价 `inline=true`，仍受 `handoffBudgetChars` 限制），`prompt.md` 顶部改成「以下是完整 brief，直接读」，并补一句「如内容被截断，请向用户索取 `brief.md` 全文」 |
| `verifyBuild`（`close`） | `off`（默认） | 现状：只做结构校验，回执自述原样落账 |
| | `stat` | 只校验：`changed[].file` 与 `screenshots[].path` 是否真实存在，结果进 `report.json.verification.dshStat` |
| | `rerun` | 额外对 `changed[]` 涉及的端**真跑一次构建**（复用 `kirara_build` 的执行函数，不递归调用工具），`ok` / `exitCode` / 耗时进 `report.json.verification.dshRerun`，与回执自述不一致时写进 `openIssues` 与 `nextStep` |

```js
// 纯聊天里的外部模型：一次拿到完整 brief
kirara_handoff({ action: 'open', request: '设置页加暗色开关', executor: 'chat' })

// 回执可疑时：先校验落盘，再让 DSH 自己复跑一遍构建
kirara_handoff({
  action: 'close',
  runId: 'KH-20261127-1807',
  report: '<外部回执原文>',
  verifyBuild: 'rerun',
})
// → verification: { build: 'ok', dshStat: { changedMissing: [], screenshotsMissing: [] },
//                   dshRerun: [{ project: 'media', ok: true, exitCode: 0, durationMs: 41200 }] }
//   复跑失败**不会**让 close 整体失败：回执照账，差异进 openIssues / nextStep
```

两个取舍：`stat` / `rerun` 的结果只写进 `report.json`（`report.md` 永远是回执原文，一字不改）；
`rerun` 的构建失败只是「差异」，不是「close 失败」—— 否则「回执说构建过了但其实没过」这件事
会因为一次异常彻底丢失。

四条边界是刻意划的：

- **不管理外部模型。** 插件不发请求、不轮询、不做网络探测 —— 文件和人是唯一的传递通道。
  因此不会因为「外部模型挂了」把工具调用卡住。
- **回执是外部输入，只校验不执行。** `report` 里的任何字符串都不会被拼进命令行；
  `screenshots[].path` 只在 `shots/` 里解析并 `stat`，指向目录外的一律标成 `outside`。
- **拒收是明确的。** 缺 `status` / `summary` / `changed` 任意一项 ⇒ `ok:false` + 少哪一项，
  并且不写 `report.json` —— 半份结构写下去，下一步的文档同步会把它当事实。
- **路径不越界。** `runId` 只接受 `KH-YYYYMMDD-HHMM` 形态（同分钟连续 open 会补 `-2`），
  resolve 后必须仍在交接目录内，`../../x` 直接被拒。

细节（九节各写什么、回执契约、外部模型只回了一半怎么处理）见[外部强模型交接](docs/handoff.md)。

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
| `docsBudgetChars` | `4000` | `kirara_docs` 单次返回的字符总预算（search / map / section 共用；section 的正文上限为该值 − 300） |
| `textBudgetChars` | `2400` | 叙述型工具（start/profile/verify/summary/handoff）单次返回的字符总预算。原为 1600，抬高的原因是 UI 设计复核协议**要被原样执行**，截断即失效 |
| `docsyncBudgetChars` | `2400` | `kirara_docsync` 单次返回的字符总预算 |
| `docsyncMaxTargets` | `4` | `kirara_docsync` 最多推荐几篇文档 |
| `releaseTimeoutMs` | `2400000` | `kirara_release` 单次发布最长等待（40 分钟；Gradle release 与 `docker save` 都慢） |
| `releaseBudgetChars` | `3000` | `kirara_release` 单次返回的字符总预算（先保步骤表与校验码，再保日志尾部） |
| `releaseNotesMaxCommits` | `40` | `kirara_release_notes` 每个桶最多**列出**几条提交（真实条数另附，不会被截断掩盖） |
| `releaseNotesMaxFiles` | `25` | `kirara_release_notes` 最多列几个改动文件 |
| `releaseNotesBudgetChars` | `3200` | `kirara_release_notes` 单次返回的字符总预算 |
| `releaseOutputDir` | `''` | 发布产物落到哪个目录。留空 = 系统桌面（按 shell 的「桌面」文件夹解析，兼容 OneDrive 重定向） |
| `uiLoopDir` | `''` | `kirara_ui` 的证据/状态目录。留空 = `<Kirara_Media>/iosApp/.tmp/ui-loop`（该目录在 media 的 `.gitignore` 里整棵忽略，且 `gradlew clean` 不会动它） |
| `uiLoopBudgetChars` | `2600` | `kirara_ui` 单次返回的字符总预算 |
| `uiLoopMaxShots` | `6` | 一次最多采纳几张截图（超过就是一屏塞满图，反而看不清） |
| `uiLoopTimeoutMs` | `120000` | 设备动作（截图 / 探测）超时 |
| `uiMcpServer` | `''` | 可选：由插件代为注册的设备控制 MCP 的 `serverName`（工具名 = `mcp__<这个名字>__*`） |
| `uiMcpCommand` | `''` | 可选：该 MCP 的可执行文件（绝对路径更稳：Finder 启动的 GUI 进程 PATH 与交互式 shell 不同） |
| `uiMcpArgs` | `''` | 可选：命令行参数，空格分隔 |
| `handoffDir` | `''` | 交接目录。留空 = `<workspaceRoot>/.kirara-dev/handoff`（两边都能写到同一个物理目录；插件**不改**用户仓库的 `.gitignore`，只在目录里放 `README.txt`） |
| `handoffBudgetChars` | `6000` | `kirara_handoff(open, inline=true)` 返回正文的字符上限（`inline=false` 另有 2400 的硬预算） |
| `handoffDocHits` | `5` | brief 第 6 节最多列几条文档命中 |
| `handoffDocLineChars` | `180` | brief 第 6 节每条命中行的字符上限 |

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

工具目录本身也在预算内：11 个工具的 `name+description+parameters` 合计 **11740 字节**
（8 个工具时是 6496；新增 `kirara_release` 与 `kirara_release_notes` 带来 +2565，是本插件迄今
最大的一次目录增长；media 双端那次给 `kirara_build` 加 `target` 又加了 +402；2026-11 的分章文档层
给 `kirara_docs` 加 `mode/chapter/section`、给 `kirara_docsync` 加章节/插入计划描述，合计 +903）。
这是**一次性常驻**成本（约 +640 token 的前缀），换来的是三端各自的发布现实被固化下来 —— 发布原本是
「翻技术栈文档找命令 → 手改版本号 → 手动改名 → 手动搬桌面 → 手动算校验码 → 忘记写 README」，
每一步都能出错，且出错时产物往往已经发出去了；分章文档层又换掉了「整篇 258 KB 文档塞上下文」
与「文档写错位置」。2026-11 的实时视觉环（`kirara_ui`）又加了 +1397 —— 它换掉的是「改界面 →
等 4 分钟全量自检 → 截图 → 返工」这条反馈环，一次样式返工就够抵消这份常驻成本。
基线卡在 12000 字节（仍比一次 compaction 的代价小两个数量级）。

2026-11 的第六轮是**唯一一次「加工具的同时减工具」**：删掉 `kirara_route`（−620）把能力并入
`kirara_start(detail="route")`（+133 —— 只多了 detail 参数与两处分支），再新增 `kirara_handoff`（+889），
净增 402 字节（−620 +133 +889）—— 所以总数仍是 11 个工具，只比上一轮多 402 字节。

0.4.1（批次 2 收尾）在 `kirara_handoff` 上补了 `executor` 与 `verifyBuild` 两个参数（+280）、
在 `kirara_profile` 的输出 schema 里补了 `docIssues`（+50），合计 **+330，总数 11740 / 12000，余量 260**：
两个参数换掉的是「外部模型读不到文件却只拿到一个路径」与「回执说构建过了但没人验」，
`docIssues` 换掉的是「`PROJECTS` 里一条死链长期没人发现」。再想往工具目录里加东西，
仍要先在同一轮里删掉等量的描述字数，而不是抬 `toolSchemaBytes` 基线
（抬基线等于用常驻前缀换一次性的方便）。

## 兼容性

`peerDependencies` 声明为 `@deepseek-ai/dsh-tools@^0.2.0-rc.2`，覆盖 DSH 0.2.x 全系列
（`0.2.0-rc.2` / `0.2.0` / `0.2.1` 均可用）。

`0.3.0` 起的 **DSH** 会被判 incompatible 并自动禁用。换大版本后如果仍想用，需要 `dsh plugin allow-version`
显式授权 —— 插件没有针对新版本测过，有崩溃风险。

## 升级

插件**支持在插件管理页里自更新**：进入本插件详情页 → 页头「同步更新」→
从 GitHub 拉取最新提交、覆盖包目录、当场热重载，**不用重装、也不用重启 DSH**。
原理、产物目录、配置项与边界见[自更新](docs/self-update.md)。

- 启动后自动检查一次，之后每 6 小时一次（**只查不装**）；徽标会显示「有新版本 / 已是最新」；
- 「检查更新」随时手动查；「同步更新」下载并热重载；「回滚到上一版」把包目录还原成同步前那一份；
- 宿主半边（工具与流程）立刻生效；浏览器半边若自身有改动，刷新一次页面即可。

> ⚠️ **从「单文件插件」升到这次的文件布局，需要完全退出 DSH 再启动一次**：
> 入口从「整个实现在 `lib/index.js`」改成「引导层 `lib/index.js` + 实现层 `lib/impl.js`」，
> 引导层必须是**启动时**被加载的那份。这次之后，再更新就都不需要重启了。

### 手动更新（一般用不到）

DSH 把依赖写成 `git+…` 地址，装上那一刻是什么就一直是那个 —— 想手动跟的话：

- **固定版本（插件管理默认）** —— 在插件页卸载重装，或改 profile 清单里的 `#<commit-sha>` 再重装。
- **一直跟 `main`（推荐给自己的仓库）** —— 依赖写成
  `git+https://github.com/akeno6388/dsh-plugin-kirara-dev.git#main`，并配好上一节《跟 `main`：先掰掉 ssh》里那两条 git 配置。

```powershell
Get-ChildItem "$env:DSH_HOME\profiles" -Directory | Select-Object -ExpandProperty Name   # 查真实 profile 名
$env:DSH_PROFILE = 'desktop-017'                        # ← 填上一步查到的名字
$env:DSH_PNPM    = '…\product\d\node_modules\pnpm\bin\pnpm.cjs'   # 只在自动找不到 pnpm 时需要
node scripts\deploy.mjs                                 # 重新解析 main + 重装 + 校验不变量
```

改完必须**完全退出 DSH 再启动**，并且**开新会话** —— 旧会话里已经录下了旧版本的工具快照，不会自动修复。

> **`DSH_PROFILE` 默认值是 `desktop`，但实际目录名不一定叫这个。** 新版 DSH 的 profile 目录可能带后缀
> （本机是 `desktop-017`）。指错了，`deploy.mjs --check` 会报一堆「缺失 / 未登记」—— 那是**假警报**，
> 它只是看了个根本不存在的目录。先用上面第一条命令确认实际名字。
>
> `deploy.mjs` 还要能找到 pnpm：它在常见安装位置里搜，搜不到就得用 `DSH_PNPM` 显式指定。
> 本机是 `…\product\d\node_modules\pnpm\bin\pnpm.cjs` —— 不在 `resources\runtime\` 下，所以自动搜不到。

**⚠️ 跟 `main` 不等于每次 `deploy` 都会自动更新。** pnpm 以 lockfile 为准：只要那条解析结果还在，
它就直接打印 `Lockfile is up to date, resolution step is skipped` 并复用旧 commit —— 实测从 `c870463`
更新到 `c2da887` 时正是这样，连跑三次都没动。要真的重新解析 `main`：

```powershell
pnpm update @kirara/dsh-plugin-kirara-dev --dir "$env:DSH_HOME\profiles\$env:DSH_PROFILE"
node scripts\deploy.mjs
```

或者直接删掉 `pnpm-lock.yaml` 全量重解析（其余依赖都钉了 SHA，结果仍然确定）。

## 常见问题

**改一篇 md 也要我跑构建吗？**
不用。`mode=docs` 下 `kirara_start` 不给构建命令，`kirara_verify` 直接 `skipped`，
`kirara_summary` 的「构建验证」也写成「不适用：纯文档变更」。自动判定保守（漏判时显式传 `mode=docs`），
理由见[纯文档变更不跑构建](#纯文档变更不跑构建modedocs)。

**为什么改完 UI 它一直让我给截图？**
那是故意的。界面改动的验收标准是「看起来对不对」，而构建通过只证明能编译。
`kirara_verify` 只要发现 `summary` 命中界面/交互词族就会返回 `needScreenshots`，
要求先拿到实机截图；拿到图后用 `purpose: 'ui-design'` 换回一份 P0/P1 的修改清单。

**技术栈文档变成很多小文件了，`kirara_docs` 还能搜到吗？**
能，而且比单篇大文件更准。它自动发现 `docs/`（或 `app/docs/`）下含 ≥2 个 `NN-标题.md` 的分章集，
命中结果会带章、小节编号与显式锚点；先 `mode=map` 看目录，再 `mode=section` 读单节，比整篇 grep 省上下文。
新增项目或新增章节不用改插件，只要目录符合分章约定（见[分章文档写作规范](docs/doc-conventions.md)）。

**自动写技术栈文档会不会把内容写到错的地方？**
`kirara_docsync` 给的是**插入计划**而不是一句「更新技术栈文档」：改哪一章、改哪一节（带行号）、
或在本章末尾新增 `## NN.M`（带建议锚点和行号）、frontmatter.files 补哪些源文件、99 变更记录写在
第几行；BUG 修复还会明确禁止新开「修复 XXX」小节。改完后可以用 `kirara_docs({ mode: 'map' })`
末尾的结构审计复查断链 / 编号 / 缺 frontmatter。

**`kirara_docsync` 是不是每轮都得改文档？**
不是。它会先给变化定性：`chore`（格式化、lint、重命名变量、清死代码）明确返回「不需要改正文」；
`feature` / `fix` / `ui` 才要求同步，因为这三类改变了对外行为，而文档描述的是对外行为。

**装完在工具表里看不到 `kirara_*`？**
先确认插件已启用，然后**完全退出 DSH 再重启** —— 不是关窗口，也不是刷新页面，bundle 只在启动时读一次。
重启后请在**新会话**里验证：旧会话的历史消息里已经录下了加载失败时的工具快照，旧记录不会自动修复。

**更新了插件，但工具还是旧的（比如没有 `kirara_release`）？**
DSH 把依赖写成 `git+…` 地址，**装上那一刻是什么就一直是那个** —— 上游有新提交不会自己跟。
另外 `deploy.mjs --check` 如果报「缺失 / 未登记」，先确认 `DSH_PROFILE` 指对了：它的默认值是 `desktop`，
而实际目录名可能带后缀（本机是 `desktop-017`），指错了就会对着一个不存在的目录报一堆假警报。
完整步骤见[升级](#升级)。

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
这是 2026-10 之前的老坑，**已经修掉了**：`Kirara_Server-API.slnx` 当时引用了不存在的
`test-assets/DbCheck/DbCheck.csproj`，整解构建会在 0.8 秒内以 `MSB3202` 失败。该悬空引用已删除
（`kirara_server-api` 4db2275），整解现在可以构建成功。
`kirara_build` 仍然构建 `Kirara_Server-API.Server` 单项目：它带出 Core / Infrastructure / Shared，
4.2 秒对整解的 11 秒，是刻意保留的选择而不是绕坑。命令行里手动构建，整解与单项目现在都可以用。

**桌面端构建报平台相关错误？**
`Kirara_Server_Studio.slnx` 只注册了 `x64`，必须显式传 `-p:Platform=x64`。

**发布时提示 Docker 守护进程不可用？**
`kirara_release` 发布 api 需要 Docker Desktop 在运行。插件在动手**之前**就会探测，探不到直接拦下
并附上原始报错，不会让 `docker build` 跑到一半才失败（那时镜像层已经建了一半）。启动 Docker Desktop、
等它就绪，再跑一次即可。

**为什么 media 的发布要跑我仓库里的脚本，而不是插件自己打包？**
因为签名配置、`versionCode` 自增、输出目录这些约定都在脚本里，插件重写一遍只会与脚本漂移。
所以 media 走「脚本模式」：插件只负责传版本号、核验产物与校验码、并把文件名规范到 `_v<版本>`
（脚本已经这么命名就不动它；没有就补后缀；候选不唯一就拒绝猜测）。
desktop 同理走 `publish_all.ps1`，区别是它产出的安装包文件名固定不带版本号，所以 `_v` 后缀由插件补。

**`kirara_release` 说 README 自上个版本以来没改过，怎么办？**
这是发布门禁，不是故障。先用 `kirara_release_notes` 取「新增功能」桶，把本轮的**功能**
（不含 BUG 修复）写进 README 并提交，再重新发布即可。确实不需要改 README 时用 `force: true`，
但痕迹会留在回传里 —— 见[发布前的 README 门禁](#发布前的-readme-门禁)。

**`kirara_release_notes` 在没有版本 tag 的仓库里怎么办？**
它会退回仓库的首个提交，并在 `warnings` 里明说 —— 后端仓库（`Kirara_Server-API`）就没有任何
版本 tag。这种情况下区间会很大，提交多时会按标题折叠重复项、并按桶限量列出（**真实条数**写在每个桶
的标题里，不会被截断掩盖）。用 `from` 显式收窄更省上下文。

**为什么没有单元测试？**
这是项目约定：验证方式 = 构建 + 人工真机清单。所以 `kirara_verify` 产出的是分步骤清单，不是测试代码。
media 的 iOS 侧把这条约定做得更彻底：`kirara_ui` 直接截当前屏幕（想验哪屏就走到哪屏再截），
而 `kirara_build target=ios` 的一次性全量自检留给收敛后的验收。

**能用 `kirara_build` 验证这个插件自己吗？**
不能。`kirara_build` 只覆盖 desktop / api / media 三个子项目。插件自身的验证方式是
`node scripts/deploy.mjs --check` + `node scripts/host-dispatch.mjs`（真宿主派发，证明 11 个工具的
返回值都被宿主接受）+ 完全重启，见[本地开发](docs/local-development.md)。

**在 Mac 上开发 media 时，插件会替我跑 iOS 构建吗？**
会，前提是 `kirara_build` 跑在 **Mac 上**：`target` 省略时 macOS 默认 `ios`（= `bash iosApp/run-simulator.sh`），
直接产出模拟器截图。在 **Windows 上**它只能跑到 klib 门禁，链接 / 出包 / 模拟器自检会以
`macCommands` 的形式交回 —— 这是设计上的分工，不是能力缺失（Mac 上也没装 Android SDK，
所以 Android 回归反而必须回 Windows）。

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

- [架构与项目画像](docs/architecture.md) —— 十一个工具的实现、分章文档层、路由判定信号、文档同步规则、发布链路、`PROJECTS` 常量怎么维护
- [外部强模型交接](docs/handoff.md) —— brief 九节各写什么、回执契约、交接目录结构、失败处理（外部模型只回了一半怎么办）
- [分章文档写作规范](docs/doc-conventions.md) —— 目录/编号/frontmatter/锚点/插入模板/审计规则；换项目时照这份约定即可无缝接入
- [DSH 插件契约](docs/plugin-contract.md) —— 插件要怎么写才会被 DSH 认可并加载
- [本地开发](docs/local-development.md) —— 挂载到 profile、部署脚本、自检夹具（含真宿主派发）
- [故障排查](docs/troubleshooting.md) —— 怎么判断插件加载了没，以及几个已经踩过的坑

## 许可

MIT
