/**
 * @kirara/dsh-plugin-kirara-dev
 *
 * Kirara 多端项目（Kirara_Server_Studio / Kirara_Server-API / Kirara_Media）的 DSH 开发流程编排插件。
 *
 * 作者契约（对照 DSH 内置插件 @deepseek-ai/dsh-tool-todo 实测确认）：
 *   - ESM 模块，具名导出 `name` / `inject` / `Config` / `apply`
 *   - `Config` 用 @deepseek-ai/schemastery 声明
 *   - 工具经 `ctx.tools.register(defineTool({...}))` 注册（defineTool 来自 @deepseek-ai/dsh-tools）
 *
 * 设计取舍：
 *   本插件只做「编排 + 让模型少读大文件」两件事。真正的构建跑在 DSH 宿主进程里
 *   （child_process），因此不受 pwsh 工具沙箱的 stdio 限制，也不会占用工具超时。
 *   需要用户拍板时，插件不自己造 UI，而是产出结构化 decision 交回模型，
 *   由模型用内置的 ask_user_question 工具挂起提问。
 *
 * 三类改动的不同流程（2026-10 修订）：
 *   - 纯文档变更（mode=docs）：只写/同步 .md，**不构建、不实机验证** —— 编译产物
 *     与文档之间没有因果关系，为改一篇 md 跑一次 dotnet/gradle 是纯浪费。
 *   - 代码变更（small / full）：构建 → （full）实机清单 → **文档同步**（kirara_docsync）
 *     → 总结。新功能 / BUG 修复会改变对外行为，所以文档同步是流程的一部分，
 *     而不是「想起来才做」的附属动作。
 *   - UI 改动：截图复核是**必经环节**。kirara_verify 的 purpose=ui-design 产出的是
 *     「怎么改」的设计复核协议（P0/P1/P2 + 重截复核循环），不是「过没过」的验收表。
 *
 * 分章文档（2026-11 起，见 docs/doc-conventions.md）：
 *   `docs/技术栈文档/NN-标题.md` 是新的 AI 检索单元 —— frontmatter.files 把源文件映射到章，
 *   `## NN.M` + 显式 `<a id>` 把稳定结论映射到节。kirara_docs 因此提供 map/search/section
 *   三种模式；kirara_docsync 按改动路径选章、按标题选节，并给出「在第几行新增 NN.M / 改哪一节 /
 *   99 变更记录插哪」的插入计划，而不是一句「更新技术栈文档」。结构审计（断链/编号/缺 frontmatter）
 *   随 map 返回，防止自动写文档在长周期里把结构写散。发现规则不写死目录名：任何项目下
 *   docs/ 或 app/docs/ 里含 ≥2 个 01–89 的 NN-标题.md，就自动当成分章集。
 *
 * ── 前缀缓存契约（2026-10 修订，务必遵守）────────────────────────────────────
 *   DSH 的请求前缀缓存按「最长相同前缀」计费，插件能踩坏它的地方只有两类：
 *
 *   1) 工具目录抖动。DSH 把 `request/header`（config + tools 的 JSON 快照）记进会话；
 *      一旦装配出的工具集合与已记录的快照不等，dsh-agent-loop 会判定
 *      `toolsChanged === true` 并开启**新的 request series**，而
 *      `SystemPromptProjection.project()` 在 startsSeries 时是**原地改写系统节点 0**
 *      （对话最前面那条 system 消息），而不是在尾部追加 —— 整段历史的前缀缓存当场作废。
 *      因此：**工具名、description、parameters 必须是随进程启动就固定的字面量**，
 *      不得包含时间戳、文件状态、环境变量、随机 id 或任何运行时探测结果；
 *      也不得在运行期增删工具（`ctx.tools.register()` 在 DSH 内部已是 scope 化的
 *      effect，apply 里调用一次即绑定到插件 fiber，不要再包一层 ctx.effect）。
 *
 *   2) 上下文膨胀。上下文越大越早触发 compaction，而每次 compaction 都会改写历史头部
 *      —— 同样是一次整段前缀作废。实测（见 .dsh-debug/cache-probe3.mjs、cache-probe5.mjs）：
 *      开启本插件的历史里，单次 `kirara_docs` 曾一次塞进 12.9–15.1 KB、
 *      单次 `kirara_build` 曾一次塞进 16.8 KB；一次 compaction 在 69 万 token 的
 *      对话上会让下一条请求的 cacheRead 从 ~67 万掉到 ~8.5 千，即约 67 万 token 重算。
 *      因此：**每个工具的返回值都必须有硬预算**（见 clampText/budgetLines），
 *      宁可让模型多调一次窄查询，也不要一次灌进几 KB。
 *
 * @module @kirara/dsh-plugin-kirara-dev
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'kirara-dev';

/** DSH 服务依赖：工具注册表。 */
export const inject = ['tools'];

/**
 * 部署侧配置。
 *
 * 这些「预算类」键存在的唯一理由就是前缀缓存：每个工具的返回值都会永久留在会话里，
 * 而上下文一旦触到压缩阈值就会触发 compaction —— compaction 会重写历史头部，
 * 让整段前缀缓存作废。所以默认值一律偏小，宁可让模型多调一次窄查询。
 */
export const Config = z.object({
  workspaceRoot: z.string().default(''),
  buildTimeoutMs: z.number().default(1200000),
  /** 构建日志尾部行数（默认 25，原为 60）。 */
  buildLogTailLines: z.number().default(25),
  /** 单条构建日志行的字符上限（默认 300）。构建日志里的 NuGet/Gradle 行可以极长。 */
  buildLogLineChars: z.number().default(300),
  /** kirara_build 单次返回的字符总预算（默认 5000）；超出时先保 errors，再保日志尾部。 */
  buildBudgetChars: z.number().default(5000),
  /** kirara_docs 默认返回的命中行数（默认 12，原为 40）。 */
  docsMaxHits: z.number().default(12),
  /** kirara_docs 命中行的正文字符上限（默认 200，原为 400）。 */
  docsLineChars: z.number().default(200),
  /** kirara_docs 单次返回的字符总预算（默认 4000）。 */
  docsBudgetChars: z.number().default(4000),
  /**
   * 叙述型工具（kirara_start / kirara_route / kirara_profile / kirara_verify / kirara_summary）
   * 单次返回的字符总预算。默认 2400（原 1600）。这几个工具的自然输出本来就不大，
   * 这把锁是兜底：万一入参异常大（比如把整篇文档塞进 summary），也不至于一次灌进十几 KB。
   *
   * 为什么从 1600 抬到 2400：kirara_verify 的 UI 设计复核协议是**要原样执行**的提示词，
   * 被截断等于协议不可用；而完整一条 full+UI+文档同步的流程说明也要 1500 字符上下。
   * 2400 仍然远小于「省下一次 compaction」的量级（实测一次 compaction ≈ 67 万 token 重算）。
   */
  textBudgetChars: z.number().default(2400),
  /** kirara_docsync 单次返回的字符总预算（默认 2400）：文档清单 + 逐篇改什么。 */
  docsyncBudgetChars: z.number().default(2400),
  /** kirara_docsync 最多推荐几篇文档（默认 4，按端各自收口后整体再收口）。 */
  docsyncMaxTargets: z.number().default(4),
  /**
   * 发布打包的超时（默认 40 分钟）。
   * 为什么比 buildTimeoutMs 还长：一次发布是**串行多步**的重活 ——
   * desktop 要跑两次 dotnet publish + 原生启动器编译 + Inno Setup 编译，
   * api 要跑 docker build（多阶段：前端 npm 构建 + API 发布）再 docker save 出一个 GB 级 tar。
   * 用构建超时去卡发布，会在「差最后一步」时被杀掉并留下半成品。
   */
  releaseTimeoutMs: z.number().default(2400000),
  /** kirara_release 单次返回的字符总预算（默认 3000）。 */
  releaseBudgetChars: z.number().default(3000),
  /** kirara_release_notes 最多回传多少条提交（默认 40；超出部分只报数量）。 */
  releaseNotesMaxCommits: z.number().default(40),
  /** kirara_release_notes 最多回传多少个改动文件路径（默认 25）。 */
  releaseNotesMaxFiles: z.number().default(25),
  /** kirara_release_notes 单次返回的字符总预算（默认 3200）。 */
  releaseNotesBudgetChars: z.number().default(3200),
  /**
   * 发布产物的输出目录。默认空字符串 = 当前用户**桌面**。
   * 走 shell 文件夹 API 解析而不是拼 %USERPROFILE%\Desktop —— 桌面被 OneDrive 接管时后者会指错。
   */
  releaseOutputDir: z.string().default(''),
  /**
   * 实时视觉迭代环（kirara_ui）的证据/状态目录。默认空 = `<media>/iosApp/.tmp/ui-loop`。
   * 为什么默认落在 iosApp/.tmp：那份目录在 kirara_media 的 .gitignore 里被整棵忽略
   * （AGENTS.md 明令「截图不入库」），而 `gradlew clean` 不会动它 ——
   * 换成 app/build 下的路径会在一次 clean 之后把证据链清空，环就「看起来没跑过」。
   */
  uiLoopDir: z.string().default(''),
  /** kirara_ui 单次返回的字符总预算（默认 2600）。 */
  uiLoopBudgetChars: z.number().default(2600),
  /** kirara_ui 一次最多采纳多少张截图（默认 6）：超过就是「一次塞进一屏截图」，反而看不清。 */
  uiLoopMaxShots: z.number().default(6),
  /** 设备动作（截图 / 装包 / 启动 / UI 树）的超时（默认 120 秒）。 */
  uiLoopTimeoutMs: z.number().default(120000),
  /**
   * 可选：由本插件代为注册的设备控制 MCP 服务器（三项都空 = 只用 profile 里已配置的）。
   *
   * 只走「已配置就注册、没配置就什么也不做」这一条路，不做自动下载：
   * 本机没有 npm/npx，装第三方 MCP 是人的决定，插件只负责把它接上线。
   * 名字必须与服务器自己的 serverName 一致（工具名会是 `mcp__<这个名字>__*`）。
   */
  uiMcpServer: z.string().default(''),
  /** 对应的可执行文件（绝对路径更稳：Finder 启动的 GUI 进程 PATH 与交互式 shell 不同）。 */
  uiMcpCommand: z.string().default(''),
  /** 命令行参数，空格分隔（例如 `--sdk /Users/you/Library/Android/sdk`）。 */
  uiMcpArgs: z.string().default(''),
});

// ─────────────────────────────────────────────────────────────────────────────
// 项目画像：三端的构建/验证事实（均由实机实测确认，见 README）
// ─────────────────────────────────────────────────────────────────────────────

const PROJECTS = [
  {
    key: 'desktop',
    dir: 'Kirara_Server_Studio',
    title: 'Kirara_Server_Studio WinUI 3 桌面客户端',
    stack: 'WinUI 3 (Windows App SDK 2.3.1) + C# 13 + .NET 10 + CommunityToolkit.Mvvm 8.4 + LiteDB',
    tfm: 'net10.0-windows10.0.19041.0',
    build: {
      // ⚠️ 该 slnx 只注册了 x64 平台，必须显式传 -p:Platform=x64
      // 2026-10-15 工程更名：Kirara_Server-WinUI.slnx / .csproj → Kirara_Server_Studio.slnx / .csproj
      // （kirara_server_studio 0190ab8；同轮改名还包括根命名空间与单实例 Mutex）。
      // 旧的 WinUI 名已不存在，写在这里会让 desktop 构建以 MSB1009 直接失败。
      cmd: 'dotnet',
      args: ['build', 'Kirara_Server_Studio.slnx', '-c', 'Debug', '-p:Platform=x64', '--nologo'],
    },
    publish: { cmd: 'dotnet', args: ['publish', '-c', 'Release', '-p:Platform=x64'] },
    specs: 'Kirara_Server_Studio.slnx',
    // ⚠️ 与 API 端同一约定：只列**真实存在**的文档。
    //    需求文档.md 与 AGENTS.md 已从本仓库删除（需求现状并入技术栈文档），列在这里只会产生死链。
    // 2026-11：技术栈文档拆成 docs/技术栈文档/NN-标题.md 分章集（见文件头的「分章文档层」）。
    // 这里写目录而不是某一篇：目录里的章节由文档层自动发现，新增/拆分章节不用改 PROJECTS。
    docs: ['docs/技术栈文档'],
    techDocs: 'docs/技术栈文档',
    constraints: [
      'WebView2 的 EnsureCoreWebView2Async() 必须在 UI 线程调用',
      'WinUI3 的 PasswordBox 不支持直接 MVVM 绑定，需 code-behind 中转',
      'app.manifest 的 requireAdministrator 不可移除（TAP/Wintun 网卡需要）',
      'XAML 主题色必须用 {StaticResource KiraraAccentColorBrush}，禁止 {ThemeResource SystemAccentColor}（加载期固化）',
      '图标字体必须用 {StaticResource KiraraIconFontFamily}，禁止硬编码 Segoe Fluent Icons / Segoe MDL2 Assets',
      '新集合索引须在 AppDatabase.Initialize() 集中注册（用户切换重开库后必须重建）',
    ],
    // ── 发布画像（2026-10 新增）─────────────────────────────────────────────
    // 这里描述的是「三端各自的发布现实」，不是理想流程 —— 三端形态完全不同，
    // 所以 package.mode 分三种（collect / script / docker-tar），不做强行统一抽象。
    release: {
      // 版本号有**两个**权威来源，必须一致：安装包显示名（.iss）与程序集版本（csproj）。
      // 二者漂移时【不能】猜哪个对 —— 那会让安装包自报的版本与程序集版本对不上，
      // 而 AppUpdateService 的版本校对正是读程序集。所以冲突一律升级为阻断项交人拍板。
      versionFrom: [
        {
          label: 'installer/Kirara_Server_Setup.iss（MyAppVersion）',
          file: 'installer/Kirara_Server_Setup.iss',
          re: /#define\s+MyAppVersion\s+"([^"]+)"/,
        },
        {
          label: 'Kirara_Server_Studio.csproj（<Version>）',
          file: 'Kirara_Server_Studio.csproj',
          re: /<Version>([^<]+)<\/Version>/,
        },
      ],
      // 桌面端**不自动递增**：仓库里的版本号就是「本轮要发的版本」（1.6.6 已改好、尚未发）。
      // 要递增时显式传 bump；绝不默认改版本文件 —— 发布脚本不读它，改了也不会进产物。
      bump: 'none',
      publish: { script: 'tools/publish_all.ps1' },
      package: {
        // tools/publish_all.ps1 把安装包固定输出成 Kirara_Server_Studio_Setup_x64.exe
        // （.iss 的 OutputBaseFilename；更名前的旧名是 Kirara_Server_APP_Setup_x64），
        // **不带版本号**，也不搬桌面、不算校验码。
        // 所以「_v<版本>」后缀 + 搬桌面 + SHA256 这三件事由本插件补。
        mode: 'collect',
        from: { dir: 'bin/installer', re: /^Kirara_Server_Studio_Setup_x64\.exe$/i },
        outName: 'Kirara_Server_Studio_Setup_x64_v{version}.exe',
      },
      readme: ['README.md', 'README.en.md'],
    },
  },
  {
    key: 'api',
    dir: 'Kirara_Server-API',
    title: 'Kirara_Server-API 后端服务',
    stack: 'ASP.NET Core 10 + Aspire 13.2.4 + PostgreSQL 16/EF Core 10 + Redis + MinIO + SignalR',
    build: {
      // 只构建 Server 项目（带出 Core/Infrastructure/Shared）：实测 4.2s，整解 11s（还要算上
      // AppHost 与 frontend.esproj），按「够用且更快」选单项目。
      // 历史：2026-10 之前 Kirara_Server-API.slnx 引用了不存在的 test-assets/DbCheck/DbCheck.csproj，
      // 整解会以 MSB3202 在 0.8s 内失败 —— 那才是当初改单项目构建的起因。悬空引用已删除
      // （kirara_server-api 4db2275），整解现在可以构建成功，单项目构建只剩「更快」这一个理由。
      cmd: 'dotnet',
      args: ['build', 'Kirara_Server-API.Server/Kirara_Server-API.Server.csproj', '-c', 'Debug', '--nologo'],
    },
    run: { cmd: 'dotnet', args: ['run', '--project', 'Kirara_Server-API.AppHost'] },
    specs: 'Kirara_Server-API.slnx',
    // ⚠️ 这里只列**真实存在**的文档：kirara_docsync 会把本列表当作「该同步哪些文档」的
    //    候选来源，列了不存在的路径只会让推荐里出现死链。评论系统已在完整文档里成章
    //    （「三、评论系统 API」），不需要单独的 评论系统API文档.md。
    docs: [
      'docs/Kirara Server API 完整文档.md',
      'docs/服务端后端系统技术栈.md',
    ],
    techDocs: 'docs/服务端后端系统技术栈.md',
    constraints: [
      '统一响应格式 ApiResponse<T>：{ success, data, timestamp } / { success, error, timestamp }',
      '客户端接入遵循「新建 Remote*Service 实现 I*Service + DI 替换注册」，无需改 ViewModel/UI',
      '数据库初始化走手动 SQL：psql -h localhost -p 5888 -U kirara -d kirara -f docs/sql/init.sql',
    ],
    release: {
      // 后端**没有版本文件**：版本只活在技术栈文档 §13.0 的 docker tag 示例里
      // （docker build -t kirara-api:1.8.7 ...）。故扫描全文所有 kirara-api:X.Y.Z 取最大者
      // 当「现有版本」—— 这就是文档里的事实，不额外引入第二处版本真相。
      versionFrom: [
        {
          label: 'docs/服务端后端系统技术栈.md（§13.0 docker tag）',
          file: 'docs/服务端后端系统技术栈.md',
          re: /kirara-api:(\d+\.\d+\.\d+)/,
          pick: 'max',
        },
      ],
      // 用户明确要求：API 端「按现有版本递增 1 个小版本」。默认 patch（末位 +1）。
      // 该措辞也可能指次版本 +1 ⇒ 用 bump 参数显式收口，不靠猜。
      bump: 'patch',
      // 打包命令直接来自技术栈文档 §13.0「打包与部署流程（离线条带部署）」。
      package: {
        mode: 'docker-tar',
        image: 'kirara-api',
        tarName: 'kirara-api-{version}.tar',
        // 文档里标注「可选：本地编译预检，比 docker build 快」—— 保留它：
        // 编译错误在几十秒内暴露，而不是等 docker 多阶段构建跑完前端才发现。
        precheck: {
          cmd: 'dotnet',
          args: ['build', 'Kirara_Server-API.Server/Kirara_Server-API.Server.csproj', '-c', 'Release', '--nologo'],
        },
      },
      preflight: [{ kind: 'docker', why: 'docker build / docker save 需要 Docker 守护进程在运行' }],
      // 该仓库暂无 README（用户已明确：暂没有 README 的项目可跳过这一步）。
      // 留空数组而不是写一个不存在的路径 —— 列了不存在的路径只会让门禁永远拦人。
      readme: [],
    },
  },
  {
    key: 'media',
    dir: 'Kirara_Media',
    // 自第八十三轮起是**双端**：Android（:app 壳）+ iOS（iosApp SwiftUI 薄壳 + :shared 的 CMP UI）。
    // 标题里写明双端是有用的：kirara_start 的 targets 会把它原样回显，模型不必再猜「media 是 Android 吗」。
    title: 'Kirara_Media 双端客户端（Android + iOS）',
    stack:
      'Kotlin Multiplatform + Compose Multiplatform 共享 UI（:shared）+ Koin；Android 壳 Jetpack Compose + Hilt + OkHttp + Coil，iOS 壳 SwiftUI + WKWebView',
    // ── Android 主线（Windows 侧）────────────────────────────────────────────
    build: {
      cmd: 'gradlew.bat',
      args: ['assembleDebug', '--console=plain'],
    },
    apk: 'app/build/outputs/apk/debug/app-debug.apk',
    specs: 'settings.gradle.kts',
    // 原值指向 规划文档.md —— 该文件在仓库里并不存在，于是 kirara_start 对 media 端
    // 推荐了一篇读不到的文档。改成实际存在的那几篇。
    // ⚠️ 顺序有意义：kirara_start 的 docsToRead 按此顺序取前 4 篇。
    docs: [
      'app/docs/Kirara Media 安卓版技术栈文档.md',
      'app/docs/Kirara Media iOS P0 Mac 执行清单.md',
      'app/docs/Kirara Media iOS 迁移路线.md',
      'README.md',
      'iosApp/README.md',
    ],
    techDocs: 'app/docs/Kirara Media 安卓版技术栈文档.md',
    constraints: [
      '不跑单元测试（用户明确要求）：验证 = 构建 + 实机/模拟器验证',
      'versionCode 每次对外发布必须递增；覆盖升级须用同一 release keystore 签名',
      'Gradle 9.6.0 / JDK 17 / Android SDK 37；依赖走阿里云镜像',
      '构建后清理用 gradlew --stop（安全，只影响 Gradle）',
      // iOS 侧的硬锁只有三条是「撞了必炸」的，其余坑点见 media.ios.pitfalls
      'iOS 目标只有 iosArm64 + iosSimulatorArm64 —— 不要加 iosX64（CMP≥1.11 / Coil≥3.5 已停发该变体）',
      '版本锁 kotlin 2.2.21 / CMP 1.10.3 / ktor 3.3.0 / coil 3.3.0：Apple klib ABI ≤ 2.2.0，升任一都要连 Kotlin 一起升',
      ':shared 的 iOS framework 必须在 build.gradle.kts 里显式 binaries.framework 声明，否则 linkDebugFramework* 任务根本不存在',
    ],
    // ── iOS（双端之二）───────────────────────────────────────────────────────
    // 这一块是本轮编排改动的核心事实来源。三条前提全部来自实机实测
    // （app/docs/Kirara Media iOS P0 Mac 执行清单.md §8–§11、技术栈文档 §67/§69）：
    //   ① Windows 只能编 iOS **klib**；链接 .framework / Xcode 出包 / 模拟器自检必须在 macOS；
    //   ② macOS 上**没有 Android SDK**，所以 Mac 侧只做 iOS，Android 回归回 Windows；
    //   ③ iOS 的 UI 验证靠 simctl + 截图（本机没有 Simulator.app，GUI 是 DeviceHub.app）。
    ios: {
      title: 'iOS（SwiftUI 薄壳 iosApp + :shared 的 CMP UI）',
      bundleId: 'com.akeno6388.kirara.media.ios',
      // 刻意不含 iosX64：开发机是 Apple Silicon，且 CMP≥1.11 / Coil≥3.5 不再发布该变体（Maven 404）。
      targets: ['iosArm64', 'iosSimulatorArm64'],
      versionLock: 'kotlin 2.2.21 / CMP 1.10.3 / ktor 3.3.0 / coil 3.3.0（Apple klib ABI ≤ 2.2.0）',
      /** Windows 也能跑的最快门禁：抓「用了只在 Android 存在的 API」与 klib ABI 不合。 */
      klibTasks: [':shared:compileKotlinIosArm64', ':shared:compileKotlinIosSimulatorArm64'],
      /** 只有 macOS 能跑：链接出 shared.framework（真机 + 模拟器两个 target）。 */
      linkTasks: [':shared:linkDebugFrameworkIosSimulatorArm64', ':shared:linkDebugFrameworkIosArm64'],
      /** 一键自检脚本：构建 → 装模拟器 → 启动 → 截图 → 打印本次新增日志 + ✅/❌ 判定。 */
      script: 'iosApp/run-simulator.sh',
      device: 'iPhone 18 Pro',
      /** 截图落点（脚本的 KIRARA_OUT 默认值，相对仓库目录）。 */
      evidenceDir: 'iosApp/.tmp/ios-evidence',
      shots: ['01-login.png', '02-logged-in.png', '03-wkwebview.png', '04-wkwebview-clean.png'],
      javaHome: '~/Developer/jdk-21.0.13+9/Contents/Home',
      /** 本机没有 Simulator.app：模拟器 GUI 入口是 Xcode 27 的 DeviceHub。 */
      simGui: '/Applications/Xcode.app/Contents/Applications/DeviceHub.app',
      docs: [
        'app/docs/Kirara Media iOS P0 Mac 执行清单.md',
        'app/docs/Kirara Media iOS 迁移路线.md',
        'iosApp/README.md',
      ],
      /**
       * 「静默失败」的坑（编译期抓不到、日志里也不显眼）。
       * ⚠️ 不在 tools 的 description 里重放（那是常驻前缀），也不全塞进一次 verify ——
       * 由 kirara_verify 每次挑最相关的几条，完整清单永远指向 P0 清单 §7/§10.3/§11.3。
       */
      pitfalls: [
        'Xcode 的 Run Script 不读 ~/.zshrc：Compile Kotlin Framework 阶段必须显式 export JAVA_HOME',
        'Kotlin 的 initKoinIos() 在 Swift 里叫 doInitKoinIos()（Kotlin/Native 给 init 前缀加 do）',
        '本机没有 Simulator.app：模拟器 GUI 是 Xcode 27 的 DeviceHub.app；可复现取证只走 simctl + 截图',
        'simctl 不能打字也不能点击：键盘 / IME / 手动登录只能 DeviceHub 人肉复核',
        'WKWebView：setCookie 必须等回调再 load；Cookie 不需要 flush（Android 才需要）',
        '路由钩子必须 documentStart 注入，pushState + replaceState 都监听，且只认「最后一个」事件',
        '原生视图宿主页里别用状态对象当 LaunchedEffect 的 key（协程会被取消，日志只剩第一行）',
        'NS_ENUM 在 Kotlin/Native 是枚举类（WKUserScriptInjectionTime.Xxx）；NSDate.distantPast 要单独 import',
        'HTTP 4xx/5xx 不走 didFailNavigation，要读 decidePolicyForNavigationResponse 的 statusCode',
      ],
    },
    release: {
      versionFrom: [
        { label: 'app/build.gradle.kts（versionName）', file: 'app/build.gradle.kts', re: /versionName\s*=\s*"([^"]*)"/ },
      ],
      bump: 'none',
      // tools/build_release.ps1 的契约：-Version 必填；版本号变更时 versionCode 自动 +1，
      // 同版本重打则保持不变；签名缺失直接抛错。
      publish: { script: 'tools/build_release.ps1', versionArg: '-Version', outputArg: '-OutputDir' },
      package: {
        // 该脚本**已经**按规范产出：<输出目录>\Kirara_Media_v<版本>.apk + 同名 .sha256
        // （无 BOM、sha256sum 的「HASH *文件名」格式）。所以插件只核验、不搬运 ——
        // 再搬一次会把脚本已经算好的校验码覆盖成第二份，两处真相必然漂移。
        mode: 'script',
        outName: 'Kirara_Media_v{version}.apk',
        // 但脚本是别人的，命名规范随时可能变（用户也明确提了这一点）。
        // from.re 用来在规范名不存在时找出「本次新产生/被改写」的候选产物，补上 _v 后缀。
        from: { re: /\.apk$/i },
      },
      // 快速失败前置：脚本自己也会校验签名，但那时 gradle 可能已经跑了一轮。
      // 在拉起 gradle 之前先拦住，省下一次无谓的 assembleRelease。
      preflight: [
        {
          kind: 'file',
          file: 'keystore.properties',
          why: 'release 包必须用固定 keystore 签名，否则无法覆盖安装已装的正式版',
        },
      ],
      readme: ['README.md'],
    },
  },
];

/** 用户全局记忆里的进程清理红线，任何构建路径都必须遵守。 */
const SAFETY_RULES = [
  '禁止按进程名批量杀 dotnet.exe —— VS Code C# Dev Kit 依赖它（CPS 宿主 + MSBuild 节点），误杀会导致语言服务反复重建 / VS Code 内存飙升',
  '禁止运行 dotnet build-server shutdown —— 会关闭 VS Code 复用的 MSBuild 节点，触发 C# 扩展全项目重载',
  '正确做法：只停止自己启动的进程（端口→PID→进程树），或直接 kill 对应终端会话',
  'gradlew --stop 只影响 Gradle，安全',
  '构建/测试完成后清理后台进程',
];

// ─────────────────────────────────────────────────────────────────────────────
// 视觉复核：用 ChatECNU 的 ecnu-plus 看实机截图
// 该 provider 在 profile 的 llm-pi-ai 配置里声明为 input: [text, image]，
// 是当前唯一支持图像输入的模型（ecnu-max 仅文本）。
// 插件自身不调模型 —— 它只产出「怎么调」的协议，实际调用由模型用 llm 服务发起。
// ─────────────────────────────────────────────────────────────────────────────

const VISION_PROVIDER = 'chatecnu';
const VISION_MODEL = 'ecnu-plus';

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

function resolveRoot(config) {
  const fromConfig = (config.workspaceRoot || '').trim();
  if (fromConfig) return resolve(fromConfig);
  const env = (process.env.DSH_WORKSPACE || '').trim();
  if (env) return resolve(env);
  return resolve(process.cwd());
}

function projectDir(root, project) {
  return join(root, project.dir);
}

function findProject(root, key) {
  return PROJECTS.find((p) => p.key === key);
}

function tail(text, lines) {
  const all = text.split(/\r?\n/);
  return all.length <= lines ? text : all.slice(-lines).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 输出预算工具
//
// 为什么每个工具都必须过一遍这里：工具返回值会永久占据会话上下文。上下文越大，
// 越早触到 dsh-compaction-basic 的压缩阈值；而一次 compaction 会重写历史头部，
// 连带让 dsh-agent-loop 的 SystemPromptProjection 原地重写系统提示节点（对话第一条
// system 消息）——那一刻整段前缀缓存全部作废，下一条请求几乎从零重算。
// 实测（.dsh-debug/cache-probe5.mjs）：单次 kirara_docs 曾返回 12.9–15.1 KB，
// 单次 kirara_build 曾返回 16.8 KB；在 69 万 token 的对话上，一次 compaction 让
// 下一条请求的 cacheRead 从 ~67 万掉到 ~8.5 千。所以这里的默认值故意压得很小。
// ─────────────────────────────────────────────────────────────────────────────

/** 单行截断，附省略号说明被截了多少字符。 */
function clampLine(line, maxChars) {
  const s = String(line);
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}… (+${s.length - maxChars} chars)`;
}

/**
 * 按字符预算逐行拼接；一旦超出预算就停止并报告。
 * @returns {{lines: string[], truncated: boolean, omitted: number}}
 */
function budgetLines(lines, budgetChars) {
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (used + line.length + 1 > budgetChars && out.length > 0) {
      return { lines: out, truncated: true, omitted: lines.length - i };
    }
    out.push(line);
    used += line.length + 1;
  }
  return { lines: out, truncated: false, omitted: 0 };
}

/** 整体字符预算兜底：任何拼好的长文本出工具前都要过一遍。 */
function clampText(text, budgetChars) {
  const s = String(text);
  if (s.length <= budgetChars) return s;
  return `${s.slice(0, budgetChars)}\n… [输出已被 kirara-dev 截断：共 ${s.length} 字符，仅回传前 ${budgetChars}]`;
}

/** 从构建输出里挑出「像错误」的行，便于模型直接定位。 */
function extractErrors(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (
      /error\s+[A-Z]{2,}\d+/i.test(line) ||
      /\berror\b.*:\s*.+/i.test(line) ||
      /^\s*e:\s/.test(line) || // Kotlin 编译错误
      /FAILURE: Build failed/i.test(line) ||
      /What went wrong:/i.test(line) ||
      /error MSB\d+/i.test(line) ||
      /Task :.*FAILED/i.test(line) ||
      // Xcode / swiftc / run-simulator.sh 的失败面（iOS 侧报错形状与 dotnet/gradle 不同）：
      //   `…/Foo.swift:12:9: error: cannot find 'x' in scope`、`** BUILD FAILED **`、
      //   run-simulator.sh 自己打印的 `❌ 构建失败：` / `❌ 安装失败`。
      /^\*\* BUILD FAILED \*\*/.test(line) ||
      /\.(swift|m|mm|h):\d+:\d+:\s*error:/i.test(line) ||
      /^❌/.test(line)
    ) {
      if (!out.includes(line)) out.push(line);
    }
    if (out.length >= 25) break;
  }
  return out;
}

/** 在目录里递归找文件名匹配 pattern 的文件（限深限数，避免拖慢）。 */
function findFiles(base, pattern, maxDepth, maxHits) {
  const hits = [];
  const stack = [{ dir: base, depth: 0 }];
  while (stack.length && hits.length < maxHits) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (hits.length >= maxHits) break;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !/^(node_modules|\.git|bin|obj|build|\.gradle|\.idea|\.vs|\.kotlin)$/.test(e.name)) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else if (pattern.test(e.name)) {
        hits.push(full);
      }
    }
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// 分章文档层（2026-11）
//
// 2026-11 起技术栈文档从「一篇几百 KB 的大 md」改成「入口 + 若干分章文件」：
//
//   docs/技术栈文档/
//     01-总览与架构.md      # frontmatter(module/level/files/related) + # 01 标题
//     02-启动与外壳.md      #   ## 02.1 标题 ... 小节编号 NN.M
//     …
//     14-附录-清单总表.md   # 参考类，仍按章编号
//     99-变更记录.md        # 流水账：日期标题，按时间倒序
//
// 这套结构对 AI 检索有两个直接好处：① 先看目录再读单节，不必整篇塞进上下文；
// ② 换模型/换会话时，frontmatter 的 files 与显式 anchor 是稳定事实。
//
// 所以本层不是「再写一个全文搜索」，而是把**结构**索引出来：
//   - 识别章节文件（NN-标题.md）与写作规范等非编号文件；
//   - 解析 frontmatter（module / level / files / related）；
//   - 解析标题层级、NN.M 小节编号、<a id="..."></a> 显式锚点；
//   - 建立「源文件 → 章节」映射，供 kirara_docsync 选章、选节、给出插入位置；
//   - 审计断链 / 重复锚点 / 缺 frontmatter / 未编号小节，防止结构长期腐化。
//
// 发现规则刻意不写死目录名：任何项目下 docs/ 或 app/docs/ 里，只要某个目录
// 同时有 ≥2 个 `NN-标题.md`，就当成一个分章文档集。新增项目只需在 PROJECTS
// 里登记目录，文档层自动接上；单篇文档仍按原来的文件级检索工作。
// ─────────────────────────────────────────────────────────────────────────────

const CHAPTER_FILE_RE = /^(\d{1,3})-(.+)\.md$/i;
const DOC_SKIP_DIR_RE = /^(node_modules|\.git|bin|obj|build|dist|out|\.gradle|\.idea|\.vs|\.kotlin|coverage)$/i;
const DOC_INDEX_CACHE = new Map();
const DOC_LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function asStringList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [String(value).trim()].filter(Boolean);
}

/** 极简 YAML frontmatter：只认 key: value、行内数组、缩进 `- item` 列表。 */
function parseFrontmatter(lines) {
  if (!lines.length || lines[0].trim() !== '---') return { data: {}, bodyLine: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { data: {}, bodyLine: 0 };
  const data = {};
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value === '') {
      const items = [];
      let j = i + 1;
      while (j < end) {
        const item = /^\s+-\s+(.+)$/.exec(lines[j]);
        if (!item) break;
        items.push(item[1].trim());
        j++;
      }
      data[key] = items;
      i = j - 1;
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      data[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { data, bodyLine: end + 1 };
}

function cleanHeading(text) {
  return String(text).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}

function parseSectionNumber(title) {
  // 兼容 `03.2` 与补位编号 `03.2a`（媒体文库允许用字母补位，不跳号）。
  const m = /^(\d{1,3}\.\d+[a-z]?)(?:\s|[.、:：-]|$)/i.exec(String(title).trim());
  return m ? m[1] : '';
}

function extractLinks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('](')) continue;
    let m;
    DOC_LINK_RE.lastIndex = 0;
    while ((m = DOC_LINK_RE.exec(line)) !== null) {
      const raw = m[1].trim();
      if (!raw || /^(https?:|mailto:|tel:)/i.test(raw) || raw.startsWith('#')) continue;
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        /* 保留原样 */
      }
      const hash = decoded.indexOf('#');
      out.push({
        line: i + 1,
        target: hash >= 0 ? decoded.slice(0, hash) : decoded,
        anchor: hash >= 0 ? decoded.slice(hash + 1) : '',
      });
    }
  }
  return out;
}

function anchorNear(anchors, line) {
  let best = '';
  let bestDist = 3;
  for (const a of anchors) {
    const dist = Math.abs(a.line - line);
    if (dist < bestDist || (dist === bestDist && a.line < line)) {
      bestDist = dist;
      best = a.id;
    }
  }
  return best;
}

/** 解析一个 md 文件（章节文件或单篇文档）。失败时返回 null，不让一个坏文件拖垮整次检索。 */
function parseDocFile(desc) {
  let text;
  try {
    text = readFileSync(desc.abs, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const fm = parseFrontmatter(lines);
  const anchors = [];
  const headings = [];
  for (let i = fm.bodyLine; i < lines.length; i++) {
    const line = lines[i];
    const am = /<a\s+(?:id|name)=["']([^"']+)["'][^>]*>\s*<\/a>/i.exec(line);
    if (am) anchors.push({ id: am[1], line: i + 1 });
    const hm = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (hm) headings.push({ level: hm[1].length, title: cleanHeading(hm[2]), line: i + 1 });
  }
  const h1 = headings.find((h) => h.level === 1) ?? null;
  const h1Title = h1 ? h1.title : '';
  const h1Num = /^(\d{1,3})(?:\D|$)/.exec(h1Title);
  const num = desc.num || (h1Num ? h1Num[1] : '');
  const title = h1Title
    ? h1Title.replace(/^\d{1,3}[.\s、:：-]*/, '').trim()
    : String(desc.titleFromName || '').replace(/[-_]+/g, ' ').trim();
  const chapterTitle = title || `未命名章节 ${num || ''}`.trim();
  const isChangelog =
    desc.kind === 'changelog' ||
    /变更记录|更新记录|changelog|release\s*notes/i.test(chapterTitle) ||
    (num !== '' && Number(num) >= 90);
  const isAppendix = /附录|清单总表|appendix/i.test(chapterTitle);
  const h2s = headings.filter((h) => h.level === 2);
  const sections = h2s.map((h, index) => {
    const next = h2s[index + 1];
    const rawTitle = h.title;
    const sectionNum = parseSectionNumber(rawTitle);
    const cleanTitle = cleanHeading(rawTitle);
    return {
      num: sectionNum,
      // 标题本身带编号（`03.1 认证系统`）时把编号剥掉，展示层统一拼 `${num} ${title}`，
      // 否则会出现「03.1 03.1 认证系统」这种重复。
      title: sectionNum
        ? cleanTitle.replace(new RegExp(`^${sectionNum.replace(/\./g, '\\.')}\\s*`), '').trim() || cleanTitle
        : cleanTitle,
      line: h.line,
      endLine: next ? next.line - 1 : lines.length,
      anchor: anchorNear(anchors, h.line),
      subheadings: headings
        .filter((x) => x.level === 3 && x.line > h.line && (!next || x.line < next.line))
        .map((x) => x.title),
    };
  });
  const anchorSet = new Set(anchors.map((a) => a.id));
  return {
    abs: desc.abs,
    rel: desc.rel,
    project: desc.project,
    setDir: desc.setDir ? toPosix(relative(desc.projectRoot, desc.setDir)) : '',
    kind: desc.kind,
    bodyLine: fm.bodyLine,
    num,
    titleFromName: desc.titleFromName || '',
    chapterTitle,
    module: fm.data.module || '',
    level: fm.data.level || '',
    frontmatterFiles: asStringList(fm.data.files),
    related: asStringList(fm.data.related),
    hasFrontmatter: Object.keys(fm.data).length > 0,
    isChangelog,
    isAppendix,
    h1Title,
    lineCount: lines.length,
    lines,
    anchors: anchors.map((a) => a.id),
    anchorSet,
    sections,
    links: extractLinks(lines),
  };
}

/** 找出目录树里所有「分章文档集」目录（含 ≥2 个 NN-标题.md，不再向下递归）。 */
function findChapterDirs(dir, depth, out, seen) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // 99-变更记录 这类目录是**变更流水卷**，不是模块章：把它当成分章集会产出
  // 「改 05-1.1.0…md 第 37 条」这种错误目标。模块章只认 01–89。
  if (/^99[-_ ]/i.test(dir.split(/[\\/]/).pop() || '') && /变更记录|更新记录|changelog/i.test(dir)) return;
  const numbered = entries.filter((e) => {
    if (!e.isFile()) return false;
    const m = CHAPTER_FILE_RE.exec(e.name);
    if (!m) return false;
    const n = Number(m[1]);
    return n >= 1 && n < 90;
  });
  if (numbered.length >= 2) {
    if (!seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
    return;
  }
  if (depth <= 0) return;
  for (const e of entries) {
    if (!e.isDirectory() || DOC_SKIP_DIR_RE.test(e.name)) continue;
    findChapterDirs(join(dir, e.name), depth - 1, out, seen);
  }
}

function collectProjectDescriptors(base, p) {
  const rootDir = projectDir(base, p);
  const descs = [];
  const seen = new Set();
  const push = (abs, kind, setDir, titleFromName) => {
    const key = resolve(abs);
    if (seen.has(key)) return;
    seen.add(key);
    descs.push({
      abs: key,
      rel: toPosix(relative(base, key)),
      project: p.key,
      projectRoot: rootDir,
      kind,
      setDir,
      num: (kind === 'chapter' || kind === 'changelog') ? (CHAPTER_FILE_RE.exec(abs.split(/[\\/]/).pop())?.[1] ?? '') : '',
      titleFromName: titleFromName ?? '',
    });
  };
  const addSet = (dir) => {
    if (/^99[-_ ]/i.test(dir.split(/[\\/]/).pop() || '') && /变更记录|更新记录|changelog/i.test(dir)) return false;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    // 只把 01–89 的编号文件当模块章；99/00 是变更记录卷/索引。
    const moduleFiles = entries.filter((e) => {
      if (!e.isFile()) return false;
      const m = CHAPTER_FILE_RE.exec(e.name);
      if (!m) return false;
      const n = Number(m[1]);
      return n >= 1 && n < 90;
    });
    if (moduleFiles.length < 2) return false;
    for (const e of entries) {
      if (e.isFile() && /\.md$/i.test(e.name)) {
        const m = CHAPTER_FILE_RE.exec(e.name);
        const num = m ? Number(m[1]) : 0;
        const changelog = Boolean(m) && (num === 0 || num >= 90 || /变更记录|更新记录|changelog/i.test(m[2]));
        push(join(dir, e.name), changelog ? 'changelog' : m ? 'chapter' : 'meta', dir, m ? m[2] : '');
        continue;
      }
      // 变更记录目录（99-变更记录/、changelog/）里的分卷也属于这个集合。
      if (!e.isDirectory() || !/变更记录|更新记录|changelog|^99/i.test(e.name)) continue;
      let subEntries;
      try {
        subEntries = readdirSync(join(dir, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of subEntries) {
        if (!s.isFile() || !/\.md$/i.test(s.name)) continue;
        const m = CHAPTER_FILE_RE.exec(s.name);
        push(join(dir, e.name, s.name), 'changelog', dir, m ? m[2] : '');
      }
    }
    return true;
  };
  const scanSets = (dir, depth) => {
    const dirs = [];
    findChapterDirs(dir, depth, dirs, new Set());
    for (const d of dirs) addSet(d);
    // 分章目录之外的一级 md 仍是普通单篇文档（例如 docs/ 下的 API 完整文档）。
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      // `_写作规范.md` / `_历史原文暂存…` 是规范或临时文件，不作为可检索正文。
      if (/^_/.test(e.name)) continue;
      const full = join(dir, e.name);
      // 已属于某个分章集合的文件已在 addSet 里登记。
      if (descs.some((d) => d.abs === resolve(full))) continue;
      push(full, 'loose', '', '');
    }
  };

  for (const sub of ['docs', 'app/docs']) {
    const dir = join(rootDir, sub);
    if (existsSync(dir)) scanSets(dir, 2);
  }
  for (const rel of p.docs ?? []) {
    const full = join(rootDir, rel);
    if (!existsSync(full)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!addSet(full)) scanSets(full, 1);
    } else if (/\.md$/i.test(full)) {
      push(full, 'loose', '', '');
    }
  }
  return descs;
}

function buildProjectDocs(base, p, descs) {
  const files = [];
  for (const d of descs) {
    const parsed = parseDocFile(d);
    if (parsed) files.push(parsed);
  }
  const setMap = new Map();
  for (const f of files) {
    if (f.kind !== 'chapter' && f.kind !== 'meta' && f.kind !== 'changelog') continue;
    if (!setMap.has(f.setDir)) setMap.set(f.setDir, { dir: f.setDir, files: [] });
    setMap.get(f.setDir).files.push(f);
  }
  const sets = [];
  for (const [dir, set] of setMap) {
    const chapters = set.files
      .filter((f) => f.kind === 'chapter' && !f.isChangelog)
      .sort((a, b) => Number(a.num || 999) - Number(b.num || 999) || a.rel.localeCompare(b.rel));
    const changelogs = set.files
      .filter((f) => f.kind === 'changelog')
      .sort((a, b) => Number(a.num || 999) - Number(b.num || 999) || a.rel.localeCompare(b.rel));
    const meta = set.files.filter((f) => f.kind === 'meta');
    if (!chapters.length) continue;
    const setObj = {
      rel: dir,
      abs: join(projectDir(base, p), ...dir.split('/')),
      project: p.key,
      chapters,
      changelogs,
      meta,
      audit: auditChapterSet(set.files),
    };
    sets.push(setObj);
  }
  sets.sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    project: p.key,
    dir: p.dir,
    files,
    sets,
    loose: files.filter((f) => f.kind === 'loose'),
    chapterFiles: files.filter((f) => f.kind === 'chapter'),
    changelogFiles: files.filter((f) => f.kind === 'changelog'),
    metaFiles: files.filter((f) => f.kind === 'meta'),
  };
}

/** 结构审计：只报「会让下一轮 AI 读错/写错」的问题，并限条数。 */
function auditChapterSet(allFiles) {
  const moduleFiles = allFiles.filter((f) => f.kind === 'chapter' && !f.isChangelog);
  const warnings = [];
  const counts = {};
  const push = (code, message) => {
    counts[code] = (counts[code] || 0) + 1;
    if (warnings.length < 12) warnings.push({ code, message });
  };
  const byAbs = new Map(allFiles.map((f) => [f.abs, f]));
  for (const f of moduleFiles) {
    if (!f.hasFrontmatter) push('frontmatter', `${f.rel}：缺 frontmatter（module / level / files / related）`);
    if (f.num && f.h1Title && !new RegExp(`^${f.num}(?:\\D|$)`).test(f.h1Title)) {
      push('h1-number', `${f.rel}：H1「${f.h1Title}」未以章节号 ${f.num} 开头`);
    }
    // 首个编号小节之前的 `## 本篇范围` 是导语，不算「未编号正文」；
    // 编号开始后再出现无编号 H2 才提示。
    const firstNumbered = f.sections.findIndex((s) => s.num);
    const unnumbered = f.sections.filter((s, idx) => !s.num && (firstNumbered === -1 || idx > firstNumbered));
    if (unnumbered.length) {
      push('section-number', `${f.rel}：${unnumbered.length} 个 ## 小节未编号（应为 NN.M）；首个是「${unnumbered[0].title}」`);
    }
    // 锚点只要求**同一文件内**唯一；跨文件同名没问题（链接带文件名）。
    const seenAnchors = new Set();
    for (const a of f.anchors) {
      if (seenAnchors.has(a)) push('duplicate-anchor', `${f.rel}：锚点 #${a} 在同一文件内重复`);
      else seenAnchors.add(a);
    }
  }
  for (const f of allFiles) {
    // 规范/临时文件里的示例链接（如 `./NN-标题.md#anchor`）不是真实引用，跳过审计。
    if (f.kind === 'meta') continue;
    for (const link of f.links) {
      const targetAbs = resolve(join(f.abs, '..', link.target));
      const target = byAbs.get(targetAbs);
      if (!target) {
        // 链到文档集之外的普通文件（如 ../../README.md）只要文件真实存在就不算断链；
        // 只有文件不存在才报。
        if (!existsSync(targetAbs)) {
          push('broken-link', `${f.rel} → ${link.target}${link.anchor ? `#${link.anchor}` : ''}（目标文件不存在）`);
        }
        continue;
      }
      if (link.anchor && !target.anchorSet.has(link.anchor)) {
        push('broken-anchor', `${f.rel} → ${link.target}#${link.anchor}（目标文件里没有该锚点）`);
      }
    }
    if (f.isChangelog) continue;
    for (const rel of f.related) {
      if (!/\.md$/i.test(rel)) continue;
      const targetAbs = resolve(join(f.abs, '..', rel));
      if (!existsSync(targetAbs)) push('broken-related', `${f.rel}：related 指向不存在的 ${rel}`);
    }
  }
  return { warnings: warnings.slice(0, 8), total: Object.values(counts).reduce((a, b) => a + b, 0), counts };
}

function docFingerprint(descs) {
  return descs
    .map((d) => {
      try {
        const st = statSync(d.abs);
        return `${d.abs}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${d.abs}:missing`;
      }
    })
    .join('|');
}

/** 取某项目的文档索引（按文件 mtime/size 失效，改完 md 后下一次调用立刻看到新结构）。 */
function getProjectDocs(base, p) {
  const descs = collectProjectDescriptors(base, p);
  const fp = docFingerprint(descs);
  const cacheKey = `${base}::${p.key}::${p.dir}`;
  const hit = DOC_INDEX_CACHE.get(cacheKey);
  if (hit && hit.fp === fp) return hit.value;
  const value = buildProjectDocs(base, p, descs);
  DOC_INDEX_CACHE.set(cacheKey, { fp, value });
  return value;
}

/** 把 `Kirara_Server_Studio/Views/...` 归一成 `Views/...`，供 frontmatter.files 比对。 */
function projectRelativeChange(change, p) {
  const norm = toPosix(String(change)).replace(/^\.\//, '');
  const dir = toPosix(p.dir);
  const lower = norm.toLowerCase();
  const lowerDir = dir.toLowerCase();
  if (lower === lowerDir) return '';
  if (lower.startsWith(`${lowerDir}/`)) return norm.slice(dir.length + 1);
  const marker = `/${lowerDir}/`;
  const idx = lower.lastIndexOf(marker);
  if (idx >= 0) return norm.slice(idx + dir.length + 2);
  return norm;
}

/** 绝对路径 → 项目相对路径（`docs/技术栈文档/03-…md`）。文档工具的对外 rel 统一用这个形态。 */
function projectRelativePath(base, p, abs) {
  const rel = toPosix(relative(join(base, p.dir), abs));
  return rel.startsWith('..') ? toPosix(relative(base, abs)) : rel;
}

function basenameStem(p) {
  return toPosix(p)
    .split('/')
    .pop()
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase();
}

/** frontmatter.files 里的一条（如 `Views/Pages/LoginPage.xaml(.cs)`）与改动路径的匹配强度。 */
function matchSourceFile(changeRel, entry) {
  const norm = toPosix(changeRel).toLowerCase();
  let e = toPosix(String(entry || '')).toLowerCase().trim();
  if (!e) return 0;
  e = e.replace(/（[^）]*）\s*$/, '').trim(); // 去掉 `App.xaml.cs（ConfigureServices）` 这类说明
  const alts = [e];
  const m = /^(.*)\((\.[a-z0-9.]+)\)$/.exec(e);
  if (m) {
    alts.push(m[1]);
    alts.push(`${m[1]}${m[2]}`);
  }
  let best = 0;
  for (const alt of alts) {
    if (!alt) continue;
    if (norm === alt) best = Math.max(best, 50);
    else if (norm.endsWith(`/${alt}`)) best = Math.max(best, 45);
    else if (norm.split('/').pop() === alt) best = Math.max(best, 40);
    else if (basenameStem(norm) === basenameStem(alt)) best = Math.max(best, 30);
    // 目录前缀（`app/`、`Services/`）只能算弱信号：`app/` 会命中所有安卓文件，
    // 不能压过更具体的模块章（否则总览章永远排第一）。
    else if (alt.endsWith('/') && norm.startsWith(alt)) best = Math.max(best, 5);
  }
  return best;
}

function chapterSourceMatch(file, changedRel) {
  let specific = 0;
  let broad = 0;
  for (const change of changedRel) {
    for (const entry of file.frontmatterFiles) {
      const s = matchSourceFile(change, entry);
      if (s >= 30) specific += s;
      else broad += s;
    }
  }
  return { specific: Math.min(specific, 120), broad: Math.min(broad, 30) };
}

function chapterTokenScore(file, tokens) {
  const title = `${file.chapterTitle} ${file.module}`.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (k.length < 2) continue;
    if (title.includes(k)) score += 14;
    if (file.sections.some((s) => s.title.toLowerCase().includes(k))) score += 7;
  }
  return Math.min(score, 70);
}

/** 从一章里挑与本次改动最相关的小节（只按标题打分，正文匹配交给 kirara_docs）。 */
function bestSection(file, tokens) {
  let best = null;
  let bestScore = 0;
  for (const sec of file.sections) {
    const hay = `${sec.num} ${sec.title}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      const k = t.toLowerCase();
      if (k.length >= 2 && hay.includes(k)) score += k.length >= 4 ? 12 : 7;
    }
    if (score > bestScore) {
      bestScore = score;
      best = sec;
    }
  }
  return bestScore >= 7 ? { section: best, score: bestScore } : null;
}

function nextSectionNumber(file) {
  if (!file.num) return '';
  const prefix = `${file.num}.`;
  const minors = file.sections
    .map((s) => s.num)
    .filter((n) => n && n.startsWith(prefix))
    .map((n) => Number(n.slice(prefix.length)))
    .filter((n) => Number.isFinite(n));
  return `${prefix}${minors.length ? Math.max(...minors) + 1 : 1}`;
}

function slugifyAnchor(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g);
  return (words ? words.slice(0, 6).join('-') : '').slice(0, 48);
}

function suggestAnchor(file, num, title) {
  const base = slugifyAnchor(title) || (num ? `section-${num.replace('.', '-')}` : 'section');
  let candidate = base;
  let i = 2;
  while (file.anchorSet.has(candidate)) candidate = `${base}-${i++}`;
  return candidate;
}

function localDateStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function chapterMatchesQuery(file, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return true;
  return (
    file.num.toLowerCase() === q ||
    file.rel.toLowerCase().includes(q) ||
    `${file.num} ${file.chapterTitle} ${file.module}`.toLowerCase().includes(q)
  );
}

/**
 * 选章：先看改动路径是否命中 frontmatter.files（强信号），再看标题/小节关键词。
 * 没有强信号时退回第一章（总览），而不是把整本文档都列出来。
 */
function selectChapterFiles(set, tokens, changedRel, max = 3) {
  const scored = set.chapters
    .filter((f) => !f.isChangelog)
    .map((f) => {
      const src = chapterSourceMatch(f, changedRel);
      const token = chapterTokenScore(f, tokens);
      return {
        file: f,
        specific: src.specific,
        broad: src.broad,
        token,
        score: src.specific * 3 + src.broad + token,
        source: src.specific + src.broad,
      };
    })
    .sort(
      (a, b) =>
        b.specific - a.specific ||
        b.token - a.token ||
        b.score - a.score ||
        Number(a.file.num || 999) - Number(b.file.num || 999),
    );
  const picked = [];
  for (const item of scored) {
    if (picked.length >= max) break;
    if (picked.length === 0) {
      picked.push(item);
      continue;
    }
    // 只有弱目录前缀（如 `app/`）的章不跟进来；必须有具体文件命中或标题/小节正向相关。
    if (item.specific > 0 || item.token > 0) picked.push(item);
  }
  if (!picked.length) {
    const overview = set.chapters.find((f) => !f.isChangelog && f.num === '01') || set.chapters.find((f) => !f.isChangelog);
    if (overview) picked.push({ file: overview, score: 0, source: 0, specific: 0, broad: 0, token: 0 });
  }
  return picked;
}

/** 给一次改动做「插入计划」：改现有小节，还是在章末新增 NN.M。 */
function planChapterEdit(file, tokens, changedRel, feature, kind = 'feature') {
  const hit = bestSection(file, tokens);
  if (hit) {
    return {
      mode: 'existing',
      section: `${hit.section.num ? `${hit.section.num} ` : ''}${hit.section.title}`,
      num: hit.section.num,
      title: hit.section.title,
      anchor: hit.section.anchor,
      line: hit.section.line,
      action: `改「${hit.section.num ? `${hit.section.num} ` : ''}${hit.section.title}」这一节（从第 ${hit.section.line} 行开始）`,
    };
  }
  // BUG 修复不新开小节：修掉的是「原来是什么样」，落地方式是在描述该行为的既有段落上改写，
  // 变更流水只进 99。把「修复 XXX」写成新小节会让正文越来越像提交日志。
  if (kind === 'fix') {
    return {
      mode: 'chapter',
      section: '',
      num: '',
      title: '',
      anchor: '',
      line: 0,
      action: `在 ${file.num || ''} 章内定位描述旧行为的段落改写（BUG 修复不新增以问题命名的小节；流水写 99 变更记录）`,
    };
  }
  const num = nextSectionNumber(file);
  const title = String(feature || '').trim().slice(0, 40) || '（待定标题）';
  return {
    mode: 'new',
    section: '',
    num,
    title,
    anchor: suggestAnchor(file, num, title),
    line: file.lineCount,
    action: num
      ? `在文件末尾（第 ${file.lineCount} 行后）新增「## ${num} ${title}」，标题前一行加 <a id="${suggestAnchor(file, num, title)}"></a>`
      : `在文件末尾追加内容（该文件没有章节号，先确认它属于哪个 NN 章）`,
  };
}

function missingFrontmatterFiles(file, changedRel) {
  const missing = [];
  for (const change of changedRel) {
    if (!file.frontmatterFiles.some((entry) => matchSourceFile(change, entry) >= 30)) missing.push(change);
  }
  return missing.slice(0, 5);
}

// ── 检索 / 地图 / 单节读取（kirara_docs 的三种模式共用）──────────────────────

function docScopes(base, projectKey) {
  return (projectKey ? PROJECTS.filter((p) => p.key === projectKey) : PROJECTS).map((p) => ({
    p,
    idx: getProjectDocs(base, p),
  }));
}

function docFilesOf(idx) {
  // `_` 开头的规范/临时文件不参与正文检索（map 会单独列出文件名）。
  return [...idx.chapterFiles, ...idx.changelogFiles, ...idx.loose];
}

function docChapterLabel(file) {
  return file.num ? `${file.num} ${file.chapterTitle}` : file.chapterTitle;
}

function docSectionAt(file, lineNo) {
  let hit = null;
  for (const sec of file.sections) {
    if (sec.line <= lineNo) hit = sec;
    else break;
  }
  return hit;
}

function docSectionLabel(sec) {
  if (!sec) return '';
  return sec.num ? `${sec.num} ${sec.title}` : sec.title;
}

function searchDocScopes(scopes, { keywords, chapter, file, maxHits, docsLineChars }) {
  const needles = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  const hits = [];
  const perSection = new Map();
  let scannedFiles = 0;
  let truncated = false;
  const fileNeedle = String(file || '').toLowerCase();
  const chapterNeedle = String(chapter || '').toLowerCase();
  for (const { p, idx } of scopes) {
    for (const f of docFilesOf(idx)) {
      if (fileNeedle && !f.rel.toLowerCase().includes(fileNeedle)) continue;
      if (chapterNeedle && !chapterMatchesQuery(f, chapterNeedle)) continue;
      scannedFiles++;
      for (let i = 0; i < f.lines.length; i++) {
        if (i < f.bodyLine) continue; // frontmatter 行不参与命中，避免 `module: …` 这类噪声
        const raw = f.lines[i];
        const lower = raw.toLowerCase();
        const matched = needles.filter((k) => lower.includes(k));
        if (!matched.length) continue;
        const sec = docSectionAt(f, i + 1);
        const key = `${f.abs}#${sec ? sec.line : 0}`;
        const used = perSection.get(key) || 0;
        if (used >= 3) continue;
        let score = matched.length * 4;
        const chapterHay = `${f.chapterTitle} ${f.module}`.toLowerCase();
        const sectionHay = docSectionLabel(sec).toLowerCase();
        for (const k of matched) {
          if (chapterHay.includes(k)) score += 12;
          if (sectionHay.includes(k)) score += 8;
          if (f.frontmatterFiles.some((entry) => entry.toLowerCase().includes(k))) score += 10;
        }
        if (/^\s*#{1,6}\s/.test(raw)) score += 6;
        if (f.isChangelog) score -= 3;
        if (f.kind === 'meta') score -= 5;
        hits.push({
          project: p.key,
          file: f.rel,
          line: i + 1,
          chapter: docChapterLabel(f),
          section: docSectionLabel(sec),
          ...(sec && sec.anchor ? { anchor: sec.anchor } : {}),
          text: clampLine(raw.trim(), docsLineChars),
          score,
        });
        perSection.set(key, used + 1);
        if (hits.length >= 2000) {
          truncated = true;
          break;
        }
      }
      if (hits.length >= 2000) break;
    }
    if (hits.length >= 2000) break;
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  const picked = hits.slice(0, maxHits);
  if (hits.length > picked.length) truncated = true;
  return { hits: picked.map(({ score, ...rest }) => rest), scannedFiles, truncated };
}

function mapDocScopes(scopes, chapter) {
  const groups = [];
  const warnings = [];
  let scannedFiles = 0;
  for (const { p, idx } of scopes) {
    scannedFiles += idx.files.length;
    for (const set of idx.sets) {
      const chapters = set.chapters
        .filter((f) => !f.isChangelog && chapterMatchesQuery(f, chapter))
        .map((f) => ({
          project: p.key,
          set: set.rel,
          num: f.num,
          title: f.chapterTitle,
          module: f.module,
          level: f.level,
          sections: f.sections.map((s) => ({
            num: s.num,
            title: s.title,
            anchor: s.anchor,
            line: s.line,
          })),
        }));
      const changelogs = set.changelogs ?? [];
      const volumes = changelogs.filter((f) => Number(f.num) !== 0);
      const latest = volumes[volumes.length - 1] ?? changelogs[changelogs.length - 1];
      if (!chapters.length && !(latest && chapterMatchesQuery(latest, chapter))) continue;
      groups.push({
        project: p.key,
        rel: set.rel,
        chapters,
        ...(latest
          ? {
              changelog: {
                num: '99',
                title: '变更记录',
                entries: volumes.reduce((n, f) => n + f.sections.length, 0),
                volumes: volumes.length || 1,
                latestVolume: `${latest.num} ${latest.chapterTitle}`,
                latestEntry: latest.sections[0]?.title ?? '',
              },
            }
          : {}),
        meta: set.meta.map((f) => f.rel.split('/').pop()),
        audit: set.audit,
      });
      for (const w of set.audit.warnings) warnings.push(w.message);
    }
    if (!chapter) {
      for (const f of idx.loose) {
        if (/license|许可协议|readme|changelog|变更记录/i.test(f.rel)) continue;
        groups.push({ project: p.key, rel: f.rel, loose: true, sections: f.sections.length, title: f.chapterTitle });
      }
    }
  }
  return { groups, warnings: [...new Set(warnings)].slice(0, 6), scannedFiles };
}

function findDocSection(scopes, { section, chapter }) {
  const q = String(section || '').trim().replace(/^#/, '').toLowerCase();
  if (!q) return { match: null, candidates: [] };
  const candidates = [];
  let match = null;
  let best = 0;
  for (const { p, idx } of scopes) {
    for (const f of [...idx.chapterFiles, ...idx.changelogFiles, ...idx.loose]) {
      if (chapter && !chapterMatchesQuery(f, chapter)) continue;
      for (const sec of f.sections) {
        const num = sec.num.toLowerCase();
        const title = sec.title.toLowerCase();
        const anchor = sec.anchor.toLowerCase();
        let score = 0;
        if (num && num === q) score = 100;
        else if (anchor && anchor === q) score = 95;
        else if (`${num} ${title}`.trim() === q) score = 90;
        else if (title === q) score = 80;
        else if (q.length >= 2 && title.includes(q)) score = 60 + Math.min(q.length, 10);
        else if (q.length >= 2 && `${num} ${title}`.includes(q)) score = 55;
        if (score > 0) candidates.push({ project: p.key, file: f.rel, num: sec.num, title: sec.title });
        if (score > best) {
          best = score;
          match = { p, file: f, sec };
        }
      }
    }
  }
  return { match, candidates: candidates.slice(0, 5) };
}

/**
 * 宿主机形态 —— 「谁能跑什么」的唯一真相来源。
 *
 * Kirara_Media 自第八十三轮起是**双端**项目（Android + iOS，见 media.ios），而 iOS 的
 * 链接 / Xcode 出包 / 模拟器自检**只能在 macOS 上**做（Apple 工具链），Windows 侧只能编
 * iOS **klib**。这条事实决定：同一个 kirara_build(project=media) 在两台机器上要给出
 * 不同的命令，而不是把 mac 命令行原样丢到 Windows 上 ENOENT。
 *
 * ⚠️ 它**不能**出现在任何工具的 description/parameters 里（cache-budget 的易变内容检查会红，
 * 而且描述必须是随启动固定的字面量）；只能用于 execute() 的结果。
 */
const HOST_PLATFORM = process.platform;
const IS_MAC = HOST_PLATFORM === 'darwin';
const IS_WIN = HOST_PLATFORM === 'win32';

/**
 * 按宿主给出 gradle wrapper 的调用方式。
 * Windows 必须走 `.bat`（spawn 需要 shell 关联）；macOS/Linux 用 `sh ./gradlew`，
 * 这样即使克隆时丢了可执行位也能跑（P0 清单 §7 第一条坑就是这个）。
 * @param {string[]} args - gradle 任务与开关。
 * @returns {{cmd: string, args: string[]}}
 */
function gradleInvocation(args) {
  return IS_WIN ? { cmd: 'gradlew.bat', args } : { cmd: 'sh', args: ['./gradlew', ...args] };
}

/** 展开文档里写的 `~/Developer/...`（JAVA_HOME 就是这种写法）。 */
function expandHome(p) {
  const s = String(p || '');
  if (!s.startsWith('~')) return s;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return `${home}${s.slice(1)}`;
}

/** 跑一个子进程，收集 stdout+stderr，带超时与取消。`extraEnv` 覆盖继承来的环境变量。 */
function runProcess(cmd, args, cwd, timeoutMs, extraEnv) {
  return new Promise((res) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ ...result, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* 忽略 */
      }
      finish({ ok: false, code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);

    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    try {
      child = spawn(cmd, args, {
        cwd,
        shell: useShell,
        windowsHide: true,
        env: {
          ...process.env,
          DOTNET_CLI_TELEMETRY_OPTOUT: '1',
          DOTNET_NOLOGO: '1',
          ...(extraEnv ?? {}),
        },
      });
    } catch (err) {
      finish({ ok: false, code: null, timedOut: false, stdout, stderr: String(err?.message ?? err) });
      return;
    }

    child.stdout?.on('data', (b) => {
      stdout += b.toString();
    });
    child.stderr?.on('data', (b) => {
      stderr += b.toString();
    });
    child.on('error', (err) => {
      finish({ ok: false, code: null, timedOut: false, stdout, stderr: stderr + String(err?.message ?? err) });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, timedOut: false, stdout, stderr });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 发布：版本号解析 / git 变更区间 / 校验码 / 桌面路径
//
// 这一组是模块级纯函数（除了确实要起进程的那几个），理由与本次其余代码一致：
// 不依赖 config 的逻辑不放进 apply() 的闭包，夹具才能直接验证它。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本机 PowerShell 宿主。
 *
 * ⚠️ 实机探测结论（2026-10）：这台机器**只有 Windows PowerShell 5.1**，没有 pwsh
 * （Get-Command pwsh 为空、$PSVersionTable 是 5.1）。所以不写死 pwsh：优先取
 * System32 下那个永远存在的 powershell.exe，取不到再退回 PATH 上的名字。
 *
 * 另外：发布脚本是 .ps1，必须用 -File 调起。Node 的 spawn 不对 .ps1 做 shell 关联，
 * 直接 spawn('tools/x.ps1') 只会 ENOENT。
 */
function powershellExe() {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  for (const c of [
    join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(sysRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]) {
    if (existsSync(c)) return c;
  }
  return 'powershell.exe';
}

/**
 * 调起 .ps1 的统一开关。
 * -NoProfile：不加载用户 profile（避免把机器相关的 $PROFILE 副作用带进发布）。
 * -NonInteractive：任何需要用户确认的提示（例如 Remove-Item 撞到非空目录）**直接失败**
 *   而不是把发布挂死在等待输入上 —— 无人值守的发布必须失败得干脆。
 */
function powershellArgs(scriptRel, extra = []) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptRel, ...extra];
}

// ── 版本号 ───────────────────────────────────────────────────────────────────
// 只认 1.6.6 / v0.9.8-beta 这类语义化写法；认不出来的版本号一律拒绝自动递增，
// 因为「猜一个版本号然后打进镜像标签」是不可回滚的。
const VERSION_RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+]([0-9A-Za-z.-]+))?$/;

function parseVersion(value) {
  const m = VERSION_RE.exec(String(value ?? '').trim());
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    // 预发布后缀（-beta）在递增时**原样保留**：0.9.8-beta → 0.9.9-beta，
    // 而不是悄悄把它变成一个正式版 —— 那会让用户在不知情的情况下收到正式版。
    suffix: m[4] ? '-' + m[4] : '',
  };
}

/** 数值化比较；无法解析的一方视为更小（排在前面）。 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] - pb[k];
  }
  if (pa.suffix === pb.suffix) return 0;
  if (!pa.suffix) return 1; // 正式版 > 同号预发布版（与 semver 一致）
  if (!pb.suffix) return -1;
  return pa.suffix < pb.suffix ? -1 : 1;
}

/** 按 bump 计算下一个版本号；版本号不可解析时返回 undefined（由调用方升级为阻断项）。 */
function bumpVersion(value, kind) {
  const p = parseVersion(value);
  if (!p) return undefined;
  if (kind === 'major') return (p.major + 1) + '.0.0' + p.suffix;
  if (kind === 'minor') return p.major + '.' + (p.minor + 1) + '.0' + p.suffix;
  if (kind === 'patch') return p.major + '.' + p.minor + '.' + (p.patch + 1) + p.suffix;
  return p.major + '.' + p.minor + '.' + p.patch + p.suffix;
}

/**
 * 按项目画像声明的来源读取「现有版本」。
 * 返回逐来源明细而不是只返回一个字符串：desktop 端有两个权威来源，
 * 漂移时必须让人看见「哪个文件说的是几」，否则无从判断该改哪一个。
 */
function readProjectVersion(root, project) {
  const sources = project.release?.versionFrom ?? [];
  const details = [];
  const values = [];
  for (const s of sources) {
    const abs = join(root, project.dir, s.file);
    const label = s.label ?? s.file;
    if (!existsSync(abs)) {
      details.push({ label, file: s.file, status: 'missing' });
      continue;
    }
    let text = '';
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      details.push({ label, file: s.file, status: 'unreadable' });
      continue;
    }
    const flags = s.re.flags.includes('g') ? s.re.flags : s.re.flags + 'g';
    const hits = [...text.matchAll(new RegExp(s.re.source, flags))].map((m) => m[1]).filter(Boolean);
    if (hits.length === 0) {
      details.push({ label, file: s.file, status: 'no-match' });
      continue;
    }
    // pick:'max' 用于「版本只散落在文档正文里」的仓库（后端）：取全文最大者当现有版本。
    const value = s.pick === 'max' ? hits.slice().sort(compareVersions).at(-1) : hits[0];
    details.push({ label, file: s.file, status: 'ok', value });
    values.push({ label, value });
  }
  const distinct = [...new Set(values.map((v) => v.value))];
  return {
    version: values[0]?.value,
    details,
    // 冲突 = 多个来源给出版本号且互不相同 —— 绝不自作主张挑一个。
    conflict: distinct.length > 1,
  };
}

// ── git ──────────────────────────────────────────────────────────────────────

/** 仓库里版本号最大的、且是 HEAD 祖先的 tag（1.6.5 / v0.9.7-beta 两种命名都认）。 */
async function latestVersionTag(dir) {
  const r = await runProcess('git', ['tag', '--merged', 'HEAD'], dir, 60000);
  if (!r.ok) return undefined;
  const versioned = r.stdout
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((tag) => ({ tag, value: tag.replace(/^v/i, '') }))
    .filter((o) => parseVersion(o.value));
  if (versioned.length === 0) return undefined;
  versioned.sort((a, b) => compareVersions(a.value, b.value));
  return versioned.at(-1);
}

/** 仓库的首个提交：没有任何版本 tag 时的兜底基线。 */
async function rootCommit(dir) {
  const r = await runProcess('git', ['rev-list', '--max-parents=0', 'HEAD'], dir, 60000);
  if (!r.ok) return undefined;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
}

/**
 * 读「上个版本 → 本次」的提交列表。
 *
 * 用 %x1f（单元分隔符）当字段分隔符而不是空格/竖线：提交标题里什么都可能有，
 * 用可打印字符做分隔符迟早会把一条提交切错（标题里带空格是常态）。
 */
async function readCommits(dir, from, to) {
  const fmt = ['%H', '%h', '%ad', '%s'].join('%x1f');
  const r = await runProcess('git', ['log', from + '..' + to, '--pretty=format:' + fmt, '--date=short', '--no-merges'], dir, 120000);
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'git log 失败').trim().split(/\r?\n/).slice(0, 2).join(' ') };
  const commits = r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, short, date, ...rest] = line.split('\u001f');
      return { sha, short, date, subject: rest.join('\u001f') };
    })
    .filter((c) => c.sha && c.subject !== undefined);
  return { ok: true, commits };
}

/** 该文件在区间内是否被改动过 —— README 门禁的硬证据。 */
async function fileTouchedSince(dir, from, rel, to) {
  const r = await runProcess('git', ['log', '--oneline', '--no-merges', from + '..' + to, '--', rel], dir, 60000);
  if (!r.ok) return undefined;
  return r.stdout.trim().length > 0;
}

/** 该文件是否被 git 跟踪：**未跟踪**时「没改动过」不构成证据（可能只是还没提交）。 */
async function fileTracked(dir, rel) {
  const r = await runProcess('git', ['ls-files', '--error-unmatch', '--', rel], dir, 60000);
  return r.ok;
}

/** 「上个版本 → 本次」之间被改动的文件（给模型当「实际代码文件」的入口，避免它全库乱翻）。 */
async function readChangedFiles(dir, from, to) {
  const r = await runProcess('git', ['diff', '--name-only', from + '..' + to], dir, 120000);
  if (!r.ok) return { files: [], total: 0 };
  const all = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { files: all, total: all.length };
}

// ── 提交分类：新功能 / 修复 / 内部整理 ───────────────────────────────────────
// 用户给的硬规则只有一条：README 里**不能**出现 BUG 与修复。
// 其余全是判断题，所以分四类而不是两类 —— ambiguous 桶存在的意义就是
// 「不替人做决定，也不把可能的功能条目悄悄丢掉」。

const CONVENTIONAL_RE = /^([a-z]+)(?:\([^)]*\))?!?:\s*/i;
const TYPE_FEATURE = new Set(['feat', 'feature']);
const TYPE_FIX = new Set(['fix', 'hotfix']);
const TYPE_INTERNAL = new Set(['chore', 'docs', 'doc', 'style', 'refactor', 'test', 'tests', 'build', 'ci', 'perf', 'revert']);

const FIX_WORDS = /修复|修正|修好|修补|排错|回滚|hotfix|\bfix(es|ed)?\b|\bbug\b|缺陷|报错|崩溃|闪退|异常|失效|不生效|回归/i;
const FEATURE_WORDS = /新增|新功能|增加|添加|支持|实现|引入|上线|增强|优化|加入|扩展|集成|接入|提供|推出|改为支持/i;
const INTERNAL_WORDS = /readme|changelog|\.md\b|文档|版本号|version\s?code|version\s?name|格式化|代码风格|lint|清理|重命名|注释|依赖(升级|更新)|构建脚本|工作流/i;

/**
 * 判一条提交属于哪一桶。
 *
 * 顺序是有意的：**约定式提交前缀优先于中文关键词**。
 * 反例（实测）：feat(应用内更新): 应用内 APK 下载/校验/安装，并修正互动预览…（0.9.7-beta）
 * 它同时含「feat」和「修正」—— 先看关键词会把它当修复丢掉，而它明明是那一轮的功能主体。
 */
function classifyCommit(subject) {
  const text = String(subject ?? '');
  const conv = CONVENTIONAL_RE.exec(text);
  const type = conv ? conv[1].toLowerCase() : '';
  if (type) {
    if (TYPE_FEATURE.has(type)) return 'feature';
    if (TYPE_FIX.has(type)) return 'fix';
    if (TYPE_INTERNAL.has(type)) return 'internal';
    // 未知类型（例如 wip/merge）落到关键词继续判
  }
  if (FIX_WORDS.test(text)) return 'fix';
  if (FEATURE_WORDS.test(text)) return 'feature';
  if (INTERNAL_WORDS.test(text)) return 'internal';
  return 'ambiguous';
}

// ── 文件与路径 ───────────────────────────────────────────────────────────────

/**
 * UTF-8 无 BOM 写入。
 * 为什么专门包一层：.sha256 一旦带 BOM，sha256sum -c 会解析失败（BOM 会粘在哈希前面）。
 * Media 的发布脚本自己也是用 [System.IO.File]::WriteAllText + UTF8Encoding($false) 绕开这件事，
 * 这里对齐同一约定。
 */
function writeUtf8NoBom(path, text) {
  writeFileSync(path, text, { encoding: 'utf8' });
}

/**
 * 流式 SHA256。
 * 为什么不 readFileSync：后端的离线 tar 是 GB 量级（镜像 + 前端产物 + 运行时），
 * 一次性读进内存会把 DSH 宿主进程顶爆。
 */
function sha256File(path) {
  return new Promise((res, rej) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rej);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => res(hash.digest('hex')));
  });
}

let desktopCache;
/**
 * 解析当前用户的桌面路径。
 * 为什么不起自己拼 %USERPROFILE%\Desktop：桌面被 OneDrive 接管后真实路径是
 * %USERPROFILE%\OneDrive\Desktop（或「桌面」），拼出来的目录**存在但不对**，
 * 产物会安静地落到一个用户看不见的地方。所以问 shell 文件夹 API，取不到才用启发式。
 */
async function resolveDesktop() {
  if (desktopCache !== undefined) return desktopCache;
  const script = '[Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)';
  const r = await runProcess(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', script], process.cwd(), 30000);
  const out = (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (r.ok && out && existsSync(out)) {
    desktopCache = out;
    return desktopCache;
  }
  const home = process.env.USERPROFILE || process.env.HOME || '';
  for (const cand of [join(home, 'Desktop'), join(home, 'OneDrive', 'Desktop'), join(home, 'OneDrive', '桌面')]) {
    if (home && existsSync(cand)) {
      desktopCache = cand;
      return desktopCache;
    }
  }
  desktopCache = home ? join(home, 'Desktop') : '';
  return desktopCache;
}

/**
 * 一次发布的完整步骤表 —— dry-run 与真实执行**共用同一条路径**。
 *
 * 为什么不各写一份：如果 dry-run 的计划是另一段拼出来的文本，它与真实执行必然漂移，
 * 而「发布前看到的东西」和「实际跑的东西」不一致正是发布类工具最不能有的毛病。
 * 每个步骤带一个 run()，dry-run 时只打印 id/title/command 不调用 run()。
 *
 * run() 的返回形状统一为 { status, detail, log?, artifactName?, sha256?, checksumFile? }，
 * 且**所有可选键都必须条件展开**（宿主对返回值做 lossless JSON 快照，undefined 会被整次拒收）。
 */
function buildReleasePlan({ root, project, version, outDir, timeoutMs }) {
  const rel = project.release ?? {};
  const pkg = rel.package ?? {};
  const dir = join(root, project.dir);
  const steps = [];
  const add = (id, title, command, run) => steps.push({ id, title, command, run });

  // ── 模式 A：docker 镜像 + 离线条带（后端）────────────────────────────────
  if (pkg.mode === 'docker-tar') {
    const image = pkg.image;
    const tarName = String(pkg.tarName).replace('{version}', version);
    const tarPath = join(outDir, tarName);

    if (pkg.precheck) {
      add(
        'precheck',
        '本地编译预检（技术栈文档 §13.0 标注为可选，但比 docker build 快得多）',
        pkg.precheck.cmd + ' ' + pkg.precheck.args.join(' '),
        async () => {
          const r = await runProcess(pkg.precheck.cmd, pkg.precheck.args, dir, timeoutMs);
          const combined = r.stdout + '\n' + r.stderr;
          if (!r.ok) return { status: 'failed', detail: r.timedOut ? '编译预检超时' : 'exit=' + r.code, log: combined };
          return { status: 'ok', detail: '编译通过（' + (r.durationMs / 1000).toFixed(1) + 's）', log: combined };
        },
      );
    }

    add(
      'docker-build',
      '构建镜像（必须同时打版本标签与 latest —— compose 引用 latest）',
      'docker build -t ' + image + ':' + version + ' -t ' + image + ':latest .',
      async () => {
        const r = await runProcess('docker', ['build', '-t', image + ':' + version, '-t', image + ':latest', '.'], dir, timeoutMs);
        const combined = r.stdout + '\n' + r.stderr;
        if (!r.ok) return { status: 'failed', detail: r.timedOut ? 'docker build 超时' : 'exit=' + r.code, log: combined };
        return {
          status: 'ok',
          detail: '镜像 ' + image + ':' + version + ' + ' + image + ':latest（' + (r.durationMs / 1000).toFixed(1) + 's）',
          log: combined,
        };
      },
    );

    add(
      'docker-save',
      '导出离线条带到桌面',
      'docker save ' + image + ':' + version + ' ' + image + ':latest -o "' + tarPath + '"',
      async () => {
        const r = await runProcess('docker', ['save', image + ':' + version, image + ':latest', '-o', tarPath], dir, timeoutMs);
        const combined = r.stdout + '\n' + r.stderr;
        if (!r.ok) return { status: 'failed', detail: r.timedOut ? 'docker save 超时' : 'exit=' + r.code, log: combined };
        // 命令退出 0 也要确认文件真的在：docker save 有把错误写进 stdout 却仍退 0 的历史。
        if (!existsSync(tarPath)) return { status: 'failed', detail: 'docker save 退出 0 但找不到 tar：' + tarPath, log: combined };
        return { status: 'ok', detail: '已导出 ' + tarName, log: combined, artifactName: tarName };
      },
    );

    add('checksum', '生成 SHA256 校验文件', 'SHA256("' + tarPath + '") → ' + tarName + '.sha256', async () => {
      if (!existsSync(tarPath)) return { status: 'failed', detail: '产物不存在，无法计算校验码：' + tarPath };
      const sha = await sha256File(tarPath);
      const shaFile = tarPath + '.sha256';
      writeUtf8NoBom(shaFile, sha + ' *' + tarName + '\n');
      return { status: 'ok', detail: sha.slice(0, 16) + '… → ' + tarName + '.sha256', sha256: sha, checksumFile: shaFile, artifactName: tarName };
    });

    return steps;
  }

  // ── 模式 B/C：先跑各仓库自带的发布脚本 ────────────────────────────────────
  const scriptRel = rel.publish?.script;
  const extra = [];
  if (rel.publish?.versionArg) extra.push(rel.publish.versionArg, version);
  if (rel.publish?.outputArg && outDir) extra.push(rel.publish.outputArg, outDir);

  add(
    'publish',
    '运行仓库自带的发布脚本 ' + scriptRel,
    'powershell -NoProfile -ExecutionPolicy Bypass -File ' + scriptRel + (extra.length ? ' ' + extra.join(' ') : ''),
    async () => {
      const r = await runProcess(powershellExe(), powershellArgs(scriptRel, extra), dir, timeoutMs);
      const combined = r.stdout + '\n' + r.stderr;
      if (!r.ok) return { status: 'failed', detail: r.timedOut ? '发布脚本超时' : '脚本 exit=' + r.code, log: combined };
      return { status: 'ok', detail: '脚本退出 0（' + (r.durationMs / 1000).toFixed(1) + 's）', log: combined };
    },
  );

  const outName = String(pkg.outName ?? '').replace('{version}', version);
  const outPath = join(outDir, outName);

  if (pkg.mode === 'collect') {
    add('collect', '找产物 → 补 _v<版本> 后缀 → 搬到桌面', pkg.from.dir + '  →  ' + outPath, async () => {
      const srcDir = join(dir, pkg.from.dir);
      let found;
      try {
        found = readdirSync(srcDir, { withFileTypes: true })
          .filter((e) => e.isFile() && pkg.from.re.test(e.name))
          .map((e) => ({ name: e.name, abs: join(srcDir, e.name), mtime: statSync(join(srcDir, e.name)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0];
      } catch (error) {
        return { status: 'failed', detail: '读不到产物目录 ' + srcDir + '：' + (error?.message ?? error) };
      }
      if (!found) {
        return { status: 'failed', detail: '发布脚本退出 0，但 ' + srcDir + ' 里没有匹配 ' + String(pkg.from.re) + ' 的产物' };
      }
      copyFileSync(found.abs, outPath);
      return { status: 'ok', detail: found.name + ' → ' + outName, artifactName: outName };
    });

    add('checksum', '生成 SHA256 校验文件', 'SHA256("' + outPath + '") → ' + outName + '.sha256', async () => {
      if (!existsSync(outPath)) return { status: 'failed', detail: '产物不存在，无法计算校验码：' + outPath };
      const sha = await sha256File(outPath);
      const shaFile = outPath + '.sha256';
      writeUtf8NoBom(shaFile, sha + ' *' + outName + '\n');
      return { status: 'ok', detail: sha.slice(0, 16) + '… → ' + outName + '.sha256', sha256: sha, checksumFile: shaFile, artifactName: outName };
    });

    return steps;
  }

  // 模式 C：脚本自己已按规范输出到目标目录并写好校验码 ⇒ 只核验、不二次搬运。
  // 但脚本是别人写的，命名规范会变（用户也明确提了「脚本若没有版本号命名规范就要补 _v 后缀」），
  // 所以核验之前先兜一层「补规范后缀」：计划期给目标目录里匹配 from.re 的产物拍一张
  // name→mtime 快照，脚本跑完后规范名若不存在，就把「本次新增或被覆盖」的候选改名成规范名。
  // 快照必须在**计划期**拍 —— 所有 add() 都在计划期登记，脚本是之后才跑的。
  const scriptRe = pkg.from?.re ?? /\.[A-Za-z0-9]+$/;
  const beforeRun = new Map();
  if (outDir && existsSync(outDir)) {
    try {
      for (const e of readdirSync(outDir, { withFileTypes: true })) {
        if (e.isFile() && scriptRe.test(e.name)) beforeRun.set(e.name, statSync(join(outDir, e.name)).mtimeMs);
      }
    } catch {
      // 目录读不到就留空快照：候选判定退化成「目录里全部匹配项」，由「唯一才改名」兜住。
    }
  }

  add('verify', '核验目标目录产物与脚本写下的 SHA256 是否一致', 'SHA256("' + outPath + '")', async () => {
    let renamed;
    if (!existsSync(outPath)) {
      const candidates = [];
      if (outDir && existsSync(outDir)) {
        for (const e of readdirSync(outDir, { withFileTypes: true })) {
          if (!e.isFile() || !scriptRe.test(e.name)) continue;
          const abs = join(outDir, e.name);
          if (beforeRun.get(e.name) !== statSync(abs).mtimeMs) candidates.push({ name: e.name, abs });
        }
      }
      if (candidates.length === 0) {
        return {
          status: 'failed',
          detail: '脚本退出 0，但目标目录里既没有规范名 ' + outName + '，也没有本次新产生/被改写的候选产物（' + outDir + '）',
        };
      }
      if (candidates.length > 1) {
        // 猜错就是拿一个不相干的文件去发版，所以这里**不猜**。
        return {
          status: 'failed',
          detail: '规范名 ' + outName + ' 不存在，而本次新产生/被改写的候选不止一个：' +
            candidates.map((c) => c.name).join('、') + ' —— 无法判断哪个才是发布产物',
        };
      }
      const only = candidates[0];
      // 同名 .sha256 一起改名：只改产物会让校验码指向一个已经不存在的名字。
      renameSync(only.abs, outPath);
      if (existsSync(only.abs + '.sha256')) renameSync(only.abs + '.sha256', outPath + '.sha256');
      renamed = only.name + ' → ' + outName + '（脚本未按 _v<版本> 命名，已补规范后缀）';
    }
    const withRename = (detail) => (renamed ? renamed + '；' + detail : detail);
    const actual = await sha256File(outPath);
    const shaFile = outPath + '.sha256';
    if (!existsSync(shaFile)) {
      // 脚本没留校验码 ⇒ 补上，避免出现「有产物没校验码」的半成品。
      writeUtf8NoBom(shaFile, actual + ' *' + outName + '\n');
      return {
        status: 'ok',
        detail: withRename('脚本未留校验码，已补写 ' + outName + '.sha256'),
        sha256: actual,
        checksumFile: shaFile,
        artifactName: outName,
      };
    }
    if (renamed) {
      // 校验码正文里的文件名还指着脚本原来的名字，而 sha256sum -c 是靠那个字段找文件的 ——
      // 改名之后不重写，就会留下一个「有校验文件但永远验不过」的产物，比没有更糟。
      writeUtf8NoBom(shaFile, actual + ' *' + outName + '\n');
      return {
        status: 'ok',
        detail: withRename('校验码正文里的文件名已同步为新名字'),
        sha256: actual,
        checksumFile: shaFile,
        artifactName: outName,
      };
    }
    const declared = (readFileSync(shaFile, 'utf8').match(/[0-9a-fA-F]{64}/) ?? [''])[0].toLowerCase();
    if (declared && declared !== actual) {
      return { status: 'failed', detail: '校验码不一致：文件里是 ' + declared + '，实测 ' + actual };
    }
    return {
      status: 'ok',
      detail: '校验码一致（' + actual.slice(0, 16) + '…）',
      sha256: actual,
      checksumFile: shaFile,
      artifactName: outName,
    };
  });

  return steps;
}


/**
 * 为 README 门禁采集 git 证据。
 * 为什么值得多起两次进程：desktop / media 的默认 bump 是 none（版本号不变），
 * 只靠「README 里有没有这个版本号」会**平凡通过** —— 那个号可能上个迭代就写进去了，
 * 完全不能证明本轮的新增功能被写进了 README。而「自上个版本以来 README 被改过没有」
 * 是不能平凡满足的证据，正好对上用户的硬要求。
 */
async function collectReadmeEvidence(dir, project, from, to) {
  const rels = project.release?.readme ?? [];
  if (rels.length === 0) return undefined;
  const evidence = {};
  for (const rel of rels) {
    const entry = { tracked: await fileTracked(dir, rel) };
    // 只有**真的**拿到改动证据才写这个键。缺键与「没改过」是两回事：
    //   缺键 = 无法核验（仓库没打过版本 tag / git 查询失败）⇒ 只提醒，不拦人；
    //   touched:false = 确实一次都没改过 ⇒ 硬拦。
    // 把这两种情况混成一个 undefined，门禁就会在证据不足时误拦。
    if (from) {
      const touched = await fileTouchedSince(dir, from, rel, to);
      if (touched !== undefined) entry.touched = touched;
    }
    evidence[rel] = entry;
  }
  return evidence;
}

/** kirara_release / kirara_release_notes 接受的 bump 取值。 */
const BUMP_KINDS = new Set(['none', 'patch', 'minor', 'major']);

/**
 * 写 README 的规则（两个发布工具共用一份）。
 * 用户的原话是：这份文档**专门给用户看**，让人知道这个项目有什么功能，不涉及技术细节。
 * 所以这里的约束是硬约束 —— 尤其是第 2 条（BUG 与修复一律不进 README）。
 */
const README_INSTRUCTION =
  'README 是给**用户**看的，不是给开发者的：\n' +
  '  1. 只写用户能感知的**新增功能**：能做什么、怎么用、带来什么变化。\n' +
  '  2. **禁止**写入 BUG 修复、内部整理、依赖升级、版本号递增、文档改动本身。\n' +
  '  3. 不写技术细节：类名 / 方法名 / 表名 / SQL / 端点路径 / 框架版本 / 文件路径 / 编译开关一律不写。\n' +
  '  4. 一条一句话，落在「功能名 + 用户价值」上；与 README 已有条目重复的不再新增，\n' +
  '     已有条目被本轮增强的直接改写那一条，而不是并列两条。\n' +
  '  5. 写进 README 已有的功能章节（见 readme[].headings），沿用该文档的排版与语气。\n' +
  '  6. 顺手把文档顶部/徽章里的版本号更新为新版本 —— kirara_release 用它做发布前门禁。';

/**
 * 检查各 README 是否已经把**本版本**写进去。
 *
 * 判定刻意基于**证据**而不是猜测，且分三级：
 *   ok          —— README 已含本版本号，或自上个版本以来被改动过（本轮确实写过它）；
 *   stale       —— README 写得明明白白还是**上一个**版本号 ⇒ 硬失败（它在跟版本却没更新）；
 *   unchanged   —— README 被 git 跟踪，却自上个版本以来一次都没被改过 ⇒ 硬失败
 *                 （用户的要求就是「发布前必须把新增功能写进 README」，没动过就是不满足）；
 *   missing     —— 画像里列了却找不到 ⇒ 硬失败；
 *   unverifiable—— 既不写版本号、又没有 git 证据（未跟踪 / 没有基线 tag）⇒ **只提醒**。
 * 最后一级是有意留的：一个永远拦人的门禁等于没有门禁，人只会习惯性加 force。
 *
 * @param {object} [evidence] 形如 { 'README.md': { touched: boolean|undefined, tracked: boolean } }，
 *        没有 git（或不是仓库）时传 undefined，退化为「只看版本号」的判定。
 * @returns {{required: boolean, satisfied: boolean, targets: object[], instruction: string}}
 */
function inspectReadme(root, project, previousVersion, version, evidence) {
  const rels = project.release?.readme ?? [];
  const targets = rels.map((rel) => {
    const abs = join(root, project.dir, rel);
    const missing = { rel, exists: false, gate: 'missing', headings: [], mentionsPrevious: false, mentionsVersion: false };
    if (!existsSync(abs)) return missing;
    let text = '';
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      return missing;
    }
    const mentionsVersion = Boolean(version) && text.includes(version);
    const mentionsPrevious = Boolean(previousVersion) && previousVersion !== version && text.includes(previousVersion);
    const headings = (text.match(/^#{1,3} .+$/gm) ?? []).slice(0, 12).map((h) => h.replace(/\s+$/, ''));
    const ev = evidence?.[rel];
    let gate;
    if (mentionsVersion) gate = 'ok';
    else if (mentionsPrevious) gate = 'stale';
    else if (ev?.touched === true) gate = 'ok';
    else if (ev?.touched === false && ev?.tracked === true) gate = 'unchanged';
    else gate = 'unverifiable';
    return { rel, exists: true, gate, headings, mentionsPrevious, mentionsVersion };
  });
  const required = targets.length > 0;
  return {
    required,
    // 只要没有任何一篇「明显落后（stale）」或「列了却不存在（missing）」就算过。
    satisfied: !required || targets.every((t) => t.gate === 'ok' || t.gate === 'unverifiable'),
    targets,
    instruction: README_INSTRUCTION,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 路线启发式：关键词 → 端 → 是否需要拍板
// kirara_route（只看路线）与 kirara_start（一句话启动）共用这一份，避免两处漂移。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 关键词 → 端。可解释、可扩展，不做黑盒猜测。
 *
 * `ui: true` 标记「用户能直接看到/操作的交互功能」词族。
 * 为什么需要它：纯外观词表（见 UI_HINTS）永远补不全 —— 2026-10-05 实测「评论支持 @ 提醒」
 * 里没有任何一个外观词，于是被 auto 判成 small（构建通过即完成）。可 @ 提醒的正文就是
 * 评论框里的 @ 选择器，构建通过显然不等于提醒链路正确。
 * 这类词命中 ⇒ 直接升级为 full：构建过 ≠ 业务对（服务端通知、多用户 @、权限都是运行期事实）。
 */
/**
 * iOS 侧信号词 —— 路由、文档选择、验证清单三处共用同一份，避免「路由说 iOS、验证却给 Android 清单」
 * 这种自相矛盾。
 *
 * 为什么不只写 `ios`：用户说「在 Mac 上跑一下」「模拟器截图」「Xcode 里编译不过」时，
 * 句子里往往一个 `ios` 都没有，但意图百分之百是 iOS 侧。
 */
const IOS_SIGNALS = /\bios\b|iphone|ipad|xcode|swiftui|swiftc|simctl|wkwebview|devicehub|模拟器|双端|苹果端/i;

const ROUTE_SIGNALS = [
  {
    re: /winui|桌面|客户端|方案|令牌|实例|webview2|rdp|openvpn|jellyfin|界面|xaml|首页|评论|任务栏|托盘/i,
    key: 'desktop',
    ui: /评论|首页|界面|xaml|托盘|任务栏/i,
  },
  {
    re: /api|接口|服务端|后端|数据库|postgres|controller|signalr|minio|redis|aspire|迁移|sql|jwt|鉴权/i,
    key: 'api',
  },
  // media 是双端项目：Android 与 iOS 都归这一端（平台差异由 kirara_build 的 target 收口，
  // 不拆成两个「端」—— 它们共用 :shared 与同一批文档）。
  {
    re: /android|安卓|手机|apk|compose|kotlin|gradle|\bios\b|iphone|ipad|xcode|swiftui|simctl|wkwebview|模拟器|双端/i,
    key: 'media',
    // iOS 的 UI 效果必须看模拟器截图（构建通过完全不代表渲染正确），与 desktop 的界面词同权。
    ui: IOS_SIGNALS,
  },
];

/**
 * 用户可见的「外观/视觉」词表。
 * 「无阻塞项」不等于「不需实机验证」：构建只证明能编译，不证明看得对。
 * 这就是 mode=auto 原来的假阴性来源之一。
 */
const UI_HINTS =
  /界面|视觉|渲染|布局|样式|配色|颜色|主题|暗色|深色|亮色|夜间|外观|字体|图标|动画|过渡|交互|开关|弹窗|按钮|菜单|页面|设置页|首页|详情页|标签页|列表页|截图|xaml|theme|dark|light|appearance/i;

/**
 * 用户可见的「社交/交互功能」词族 —— 独立于外观词表。
 * 假阴性的代价不对称：把 visible 误判成 small 会让人漏掉实机验收直接发出去；
 * 误判成 full 只是多走一遍清单。所以这里刻意宁滥勿缺。
 */
const INTERACTION_SIGNALS =
  /@|提醒|通知|提及|评论|回复|点赞|收藏|分享|私信|聊天|消息|弹幕|关注|粉丝|好友|订阅|推送|收件箱|对话/i;

/** 真·破坏性/不可逆操作。故意**不含「迁移」** —— 那个词归 DB_ACTION 管，避免误伤。 */
const DESTRUCTIVE_SIGNALS = /破坏性|删除|移除|下线|停用|重命名|重构|重写|替换|更换|回滚|架构调整/i;

/**
 * 数据库结构变更 = 「变更动作」∧「数据对象」两个词都出现。
 * 只用「迁移」一词会在「把设置迁移到新 API」上误报（假阳性），
 * 所以额外要求同时出现表/库/字段/索引这类宾语。
 */
const DB_ACTION = /迁移|migration|改表|加表|建表|删表|加列|删列|改列|加索引|建索引|schema|ddl/i;
// 同样故意不含泛词「数据」：`把数据迁移到新服务器` 不该被判成表结构变更。
const DB_OBJECT = /表|库|sql|字段|列|索引|实体|entity|ef\b|upgrade_v/i;

/**
 * 纯文档变更（mode=docs）判定。真值表（A=文档对象, B=文档动作, C=文档结构词, D=代码对象）：
 *
 *     docsOnly = A ∧ (B ∨ C) ∧ (¬D ∨ C)
 *
 * 为什么不是一个词表：单看「文档」会把「新增文档上传功能」判成写文档；只看「更新」
 * 更是满大街都是；而只看「章节」又会把「章节组件」当成文档。
 *   - B ∨ C：C 的存在说明句子在谈**文档里的某段文字**（章节/段落/措辞/目录/错别字），
 *     这类句子即使不带 B 也几乎一定是改文档（「改一下文档里的接口说明」）。
 *   - ¬D ∨ C：出现代码对象的词（功能/页面/接口/组件/控件）就按代码需求处理；
 *     但如果同时有 C，说明那个词是被**描述的对象**而不是要改的东西
 *     （「更新 API 完整文档里的评论接口章节」= 改文档，不是改接口）。
 *
 * ⚠️ B 刻意**不含** 新增 / 修改 / 重构 / 实现 这类通用动作词：它们是代码动作，
 * 放进去会让「新增文档预览页面」这类真·功能需求被误判成免构建。
 * 漏判（本该 docs 却走了构建）只是多跑一次编译；误判（本该改代码却免构建）会让人
 * 以为「构建都免了所以没问题」。代价不对称 ⇒ 宁可漏判。需要时显式传 mode=docs 覆盖。
 */
const DOC_TARGET = /文档|readme|\.md\b|markdown|changelog|更新记录/i;
const DOC_ACTION = /更新|同步|补充|补齐|编写|撰写|修订|整理|校对|完善|追加|翻译|归档/i;
/** 文档**内部**的结构词：命中即说明这句话在谈某段文字，而不是某个代码对象。 */
const DOC_STRUCTURE = /章节|段落|目录|条目|措辞|文案|标题|说明|描述|表格|示例|链接|错别字|排版|正文|注释/i;
/** 出现这些词说明句子在谈一个**代码对象**，即使同时出现文档词也不按纯文档处理。 */
const DOC_CODE_OBJECT = /功能|页面|接口|端点|组件|按钮|逻辑|方法|函数|类\b|表结构|字段|索引|上传|下载|控件/i;

/**
 * 共享判定：这句话是不是纯文档变更。
 * `routeRequest`（决定走不走构建）和 `judgeChangeKind`（决定文档同步的 kind）必须用同一条
 * 规则，否则会出现「流程说免构建、文档同步却说你这是功能改动」这种自相矛盾。
 * @param {string} s - 请求或改动描述。
 * @returns {boolean}
 */
function isDocsOnlyText(s) {
  const structure = DOC_STRUCTURE.test(s);
  return DOC_TARGET.test(s) && (DOC_ACTION.test(s) || structure) && (!DOC_CODE_OBJECT.test(s) || structure);
}

/**
 * kirara_docsync 的变化类型判定信号。
 * 「自行判断」的落点就是这里：插件按词表给变化定性，而不是让模型自己声明要不要写文档。
 */
const FIX_SIGNALS = /修复|修好|修正|bug|缺陷|报错|崩溃|闪退|异常|失效|不生效|回归|hotfix|fix\b/i;
// 刻意**不含** 依赖升级 / 版本号 / 构建脚本：这些恰恰会改动技术栈文档与 README
// （文档里写着 NuGet 清单、Gradle 版本、发版步骤），归 chore 会漏掉真正该同步的文档。
// 剩下的都是「改了也不会有人从文档里读出来」的纯内部整理。
const CHORE_SIGNALS = /格式化|代码风格|lint|清理缓存|清理无用|重命名变量|注释调整|死代码|code format/i;
const FEATURE_SIGNALS = /新增|新功能|支持|实现|添加|引入|上线|feature|增强|优化/i;

/**
 * 判断一句话请求涉及哪些端、是否需要人工拍板、是否必须实机验证，以及是不是纯文档变更。
 * @param {string} text - 用户的自然语言请求。
 * @param {{small?: boolean, docs?: boolean}} [opts] - small: 已按「一句话小功能」处理（免实机验证）；
 *   docs: 显式声明纯文档变更（免构建）。
 * @returns {{keys: string[], decisions: object[], deviceRequired: boolean, reasons: string[], uiChange: boolean, docsOnly: boolean}}
 *   涉及的端 + 决策点 + 判定依据。
 */
function routeRequest(text, opts = {}) {
  const small = opts.small === true;
  const s = String(text || '');
  const keys = new Set();
  const interactionKeys = new Set();
  for (const sig of ROUTE_SIGNALS) {
    if (!sig.re.test(s)) continue;
    keys.add(sig.key);
    if (sig.ui?.test(s)) interactionKeys.add(sig.key);
  }
  // 有没有真正命中过端信号 —— 纯文档变更下这个区别很重要，见下面的 docsOnly 分支。
  const signalMatched = keys.size > 0;
  if (keys.size === 0) keys.add('desktop'); // 默认桌面端（项目主体）

  const reasons = [];
  const decisions = [];

  // 界面改动 → 「免实机验证」不成立（构建通过不代表效果正确）。
  // 两类信号任一命中都算：外观/视觉词表，或「用户看得见、能操作」的交互功能词族。
  const uiByHints = UI_HINTS.test(s);
  const uiBySignals = interactionKeys.size > 0;
  const uiByInteraction = !uiByHints && (uiBySignals || INTERACTION_SIGNALS.test(s));
  const uiChange = uiByHints || uiBySignals || uiByInteraction;

  // 纯文档变更：显式声明，或命中 isDocsOnlyText（真值表见 DOC_* 常量区，
  // 与 kirara_docsync 的 kind 判定共用同一条规则）。
  // 命中即短路 —— 破坏性/表结构/实机验证三类判定对一篇 md 全都不适用，
  // 硬跑下去只会产出「请确认不可逆」「请补 schema 细节」这类纯噪声决策，
  // 还会把一次「改文档」拖成「先拍板再构建」。
  const docsOnly = opts.docs === true || isDocsOnlyText(s);
  if (docsOnly) {
    const reasons = [
      opts.docs
        ? '显式声明为纯文档变更（mode=docs）'
        : '命中纯文档变更（文档对象 ∧（文档动作 ∨ 文档结构词）∧ 无代码对象）—— 不产生代码变更 ⇒ 免构建、免实机验证',
    ];
    // 文档请求常常没有端信号（「同步一下文档」）。此时默认成 desktop 会让另外两端的文档
    // 永远进不了候选池 —— 而文档同步恰恰是少数「本来就该跨端看一遍」的场景，所以退化成
    // 「三端都要看」，交给 kirara_docsync 按关键词收口。
    const docKeys = signalMatched ? [...keys] : PROJECTS.map((p) => p.key);
    return {
      keys: docKeys,
      decisions: [],
      deviceRequired: false,
      reasons,
      uiChange,
      // 纯文档变更也要带上这个标记：iOS 那几篇文档（P0 清单 / 迁移路线 / iosApp/README）
      // 只有在请求是 iOS 侧时才该排到前面。
      iosFocus: IOS_SIGNALS.test(s),
      docsOnly: true,
    };
  }

  if (uiChange) {
    reasons.push(
      uiByHints
        ? '命中界面/视觉关键词（构建通过 ≠ 效果正确）'
        : uiBySignals
          ? `命中 ${[...interactionKeys].join('/')} 端的交互功能关键词（${s.match(INTERACTION_SIGNALS)?.[0] ?? '@/评论类'}）—— 构建通过 ≠ 业务正确`
          : '命中交互/社交功能关键词（构建通过 ≠ 效果正确）',
    );
  }

  // 真·破坏性操作：提问要索取**缺失的细节**，而不是只要一个「确认」。
  if (DESTRUCTIVE_SIGNALS.test(s)) {
    reasons.push('命中破坏性/不可逆操作关键词');
    decisions.push({
      id: 'scope',
      blocking: true,
      question:
        `该请求「${s.slice(0, 60)}」命中破坏性/不可逆操作。推进前请补齐两点：` +
        '① 具体改动对象与范围（哪个文件/类/接口/表，改成什么）；② 是否接受不可逆。',
      options: ['补充上述细节后确认', '只做最小改动', '只出方案不改代码'],
      recommend: '补充上述细节后确认',
    });
  }

  // 数据库结构变更：必须「动作 + 数据对象」同时命中，否则只是借词。
  const dbChange = DB_ACTION.test(s) && DB_OBJECT.test(s);
  if (dbChange) keys.add('api'); // 表结构变更的归属端就是 api（`用户表加字段`这种句子未必出现 api/接口字样）
  if (dbChange) {
    reasons.push('命中数据库结构变更（变更动作 + 数据对象同时出现）');
    decisions.push({
      id: 'schema',
      blocking: true,
      question:
        '涉及数据库结构变更。已核实（1.8.6 起）：启动自动迁移已移除（不再调用 MigrateAsync），' +
        '生产库 __EFMigrationsHistory 已删除；生效路径只有手动幂等 SQL —— ' +
        'docs/sql/init.sql（新库）+ 根目录 upgrade_vN_*.sql（旧库），Infrastructure/Migrations/ 仅作历史参考。' +
        '请补齐：① 改哪张表、哪些列（列名/类型/可空/默认值）？ ② init.sql 与 upgrade_vN_*.sql 是否都要同步更新？',
      options: [
        '确认：init.sql + upgrade_vN_*.sql 两份都改（新库/旧库都覆盖）',
        '只要 upgrade_vN_*.sql（生产库已存在）',
        '暂不改表结构',
      ],
      recommend: '确认：init.sql + upgrade_vN_*.sql 两份都改（新库/旧库都覆盖）',
    });
  }

  // 实机验证诉求：界面改动无论哪端都要看效果；media 双端都要在真机/模拟器上看。
  const deviceRequired = uiChange || keys.has('media');
  // media 的 iOS 侧：命中了 iOS 词族才切到 iOS 话术，否则仍按 Android 主线走
  // （纯 android 请求不该被塞一堆 Mac 命令）。
  const iosFocus = keys.has('media') && IOS_SIGNALS.test(s);

  if (uiChange && !small) {
    decisions.push({
      id: 'ui-verify',
      blocking: false,
      question: '本次是用户可见的界面变更，实机验收要点由谁定？',
      options: ['按 kirara_verify 的默认清单', '我来补充验收要点（哪些界面状态/主题/分辨率）'],
      recommend: '按 kirara_verify 的默认清单',
    });
  }
  if (!small && iosFocus) {
    // iOS 的验证通道只有两条，选错会白跑一整轮构建：
    //   ① 实时视觉环（推荐）—— kirara_ui 想验哪屏就走到哪屏再截，每轮几秒；
    //      装了指设备控制 MCP 时连「点按/输入」都能自动做（simctl 本身不能点、不能打字）。
    //   ② 全量自检 —— kirara_build(target=ios) 一条命令出构建+4 张固定图+判定，留给收敛后的验收。
    decisions.push({
      id: 'ios-verify',
      blocking: false,
      question:
        '本次 iOS 侧改动怎么验？内环走 kirara_ui（截图 + 可选的 MCP 点按/输入），' +
        '全量自检（kirara_build target=ios）留给收敛后的验收；键盘/IME/手动登录这类仍要 DeviceHub 人肉复核。',
      options: [
        '先用实时视觉环（kirara_ui：plan → shot → 改 → review），收敛后再跑一次全量自检',
        '直接跑全量自检（kirara_build target=ios，约 4 分钟出 4 张图）',
        '只出清单，我在 Mac 上手动跑',
        '本轮不碰 iOS（只改 Android）',
      ],
      recommend: '先用实时视觉环（kirara_ui：plan → shot → 改 → review），收敛后再跑一次全量自检',
    });
  }
  if (!small && keys.has('media') && !iosFocus) {
    decisions.push({
      id: 'device',
      blocking: false,
      question: 'Android 端改动需要真机验证，本次是现在跑真机还是先出测试清单等你方便时跑？',
      options: ['先出测试清单', '现在就实机验证'],
      recommend: '先出测试清单',
    });
  }
  return { keys: [...keys], decisions, deviceRequired, reasons, uiChange, iosFocus, docsOnly: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 文档同步（kirara_docsync）
//
// 为什么要有这一段：README / docs 下的 md 是模型的作业依据（技术栈文档的构建与约束、API 文档的
// 端点表、需求现状），但它们不会因为代码改了而自己更新。新功能落地、BUG 修完，
// 文档就与代码出现偏差，而**偏差是静默的** —— 下一个会话读到的是过期事实，然后照着它写代码。
//
// 所以这里把「该同步哪几篇、每篇改哪些章节」做成可解释的规则表：变化类型 → 文档。
// 和 ROUTE_SIGNALS 一样，不做黑盒猜测，命中哪条规则会随结果一起返回（why 字段）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 变化特征 → 该更新的文档。`when` 命中即纳入候选，`docs` 里的路径按端给出。
 * 路径不存在的会在 pickDocTargets 里被剔除，所以这里可以放心列「标配文档」。
 */
const DOC_RULES = [
  {
    id: 'api-surface',
    when: /接口|端点|api\b|controller|路由|请求|响应|鉴权|jwt|token|signalr|webhook|swagger/i,
    docs: { api: ['docs/Kirara Server API 完整文档.md'] },
    why: '接口/鉴权行为变化 ⇒ API 完整文档的对应章节 + 「更新记录」',
  },
  {
    id: 'stack',
    // 构建 / 约束类信号并入本规则：AGENTS.md 已从各仓库删除，这类事实的权威落点
    // 现在就是各端的技术栈文档（分章集或单篇，由 `@tech` 按项目实际形态解析）。
    when: /技术栈|依赖|框架|版本|升级|sdk|nuget|gradle|kotlin|compose|winui|\.net\b|ef core|postgres|redis|minio|aspire|架构|连接字符串|约束|构建|规范|平台|slnx|x64|assemble|权限|红线/i,
    docs: { desktop: ['@tech'], api: ['@tech'], media: ['@tech'] },
    why: '技术栈 / 依赖 / 架构 / 构建与约束变化 ⇒ 技术栈文档（构建命令与硬约束的权威落点）',
  },
  {
    id: 'ios-side',
    // media 是双端：iOS 侧的事实有两个权威落点 —— 主技术栈文档（§64–§69 的实测结论）
    // 与 P0 清单（Mac 环境、已知提示、模拟器怎么跑）。两者都不能漏：
    // 只改技术栈文档会让下一轮重新踩 Xcode/JAVA_HOME/DeviceHub 的坑。
    when: IOS_SIGNALS,
    docs: {
      media: [
        '@tech',
        'app/docs/Kirara Media iOS P0 Mac 执行清单.md',
      ],
    },
    why: 'iOS 侧构建/验证/环境坑点变化 ⇒ 技术栈文档 §64–§69（事实与实测）+ iOS P0 清单（环境与坑）',
  },
  {
    id: 'requirement',
    when: /需求|功能|交互|流程|体验|界面|ui\b|首页|评论|设置|登录|收藏|通知|列表|页面|上传|下载|令牌|实例|账号|认证|加密|方案|消息|主题|远程|接入/i,
    // 需求现状已经并入各端技术栈文档；分章集里由 frontmatter.files 选到具体模块章。
    docs: { desktop: ['@tech'], api: ['@tech'], media: ['@tech'] },
    why: '功能 / 交互行为变化 ⇒ 技术栈文档的落地记录章节',
  },
  {
    id: 'readme',
    when: /安装|用法|使用说明|上手|发版|发布|版本号|下载|apk|release|部署/i,
    docs: { desktop: ['README.md'], api: ['README.md'], media: ['README.md'] },
    why: '安装 / 发版 / 用法变化 ⇒ README',
  },
];

/** 文档里泛到没有区分度的词，命中它们等于命中所有章节。 */
const SECTION_STOPWORDS = new Set(['更新', '同步', '文档', '修改', '补充', '整理', '完善', '支持', '优化', '新增']);

/** 从「改动描述 + 变更文件」里抽特征词：整词 + 中文 2-gram + 文件名主干。 */
function featureTokens(feature, changes) {
  const tokens = new Set();
  for (const part of String(feature || '').split(/[\s,，、。；;：:（）()\[\]【】/\\|+]+/)) {
    const t = part.trim();
    if (t.length >= 2) tokens.add(t);
    if (t.length >= 4 && /[\u4e00-\u9fa5]/.test(t)) {
      for (let i = 0; i + 2 <= t.length; i++) tokens.add(t.slice(i, i + 2));
    }
  }
  for (const c of changes) {
    const base = String(c).replace(/\\/g, '/').split('/').pop() ?? '';
    const stem = base.replace(/\.[a-z0-9]+$/i, '');
    if (stem.length >= 3) tokens.add(stem);
  }
  for (const noise of SECTION_STOPWORDS) tokens.delete(noise);
  return [...tokens];
}

/** 读出文档的 1~3 级标题（限 300 条，避免把 266 KB 文档整篇铺开）。 */
function collectHeadings(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1].replace(/[\`*]/g, '').trim());
    if (out.length >= 300) break;
  }
  return out;
}

/** 在标题里挑出与本次改动最相关的几条（按最长命中词排序，最多 3 条）。 */
function pickSections(file, tokens) {
  let headings;
  try {
    headings = collectHeadings(file);
  } catch {
    return [];
  }
  const scored = [];
  for (const h of headings) {
    let best = 0;
    for (const t of tokens) if (t.length > best && h.includes(t)) best = t.length;
    if (best >= 2) scored.push({ h, best });
  }
  scored.sort((a, b) => b.best - a.best);
  const picked = [];
  for (const { h } of scored) {
    if (picked.length >= 3) break;
    if (!picked.includes(h)) picked.push(h.length > 40 ? `${h.slice(0, 40)}…` : h);
  }
  // 「更新记录」始终是个有效的落点（API 完整文档、技术栈文档都有这一节）。
  // 命中标题全落空时它更是唯一有意义的建议，所以这里补进去而不是只在空手时兜底。
  if (picked.length < 3 && headings.includes('更新记录') && !picked.includes('更新记录')) {
    picked.push('更新记录');
  }
  return picked;
}

/** 变化类型判定 —— 「自行判断要不要写文档」的落点。 */
function judgeChangeKind(feature, changes) {
  const s = `${feature}\n${changes.join('\n')}`;
  if (isDocsOnlyText(s)) return 'docs';
  if (FIX_SIGNALS.test(s)) return 'fix';
  if (CHORE_SIGNALS.test(s) && !FEATURE_SIGNALS.test(s)) return 'chore';
  if (UI_HINTS.test(s) || INTERACTION_SIGNALS.test(s)) return 'ui';
  return 'feature';
}

const KIND_LABEL = {
  feature: '新增/扩展功能 —— 对外行为变了，文档必须跟上',
  fix: 'BUG 修复 —— 把「原来是什么样」修掉了，文档里描述旧行为的地方就是错的',
  ui: '界面/交互改动 —— 界面契约（入口、状态、主题）变了，技术栈文档要跟上',
  docs: '文档本身的编写/同步',
  chore: '纯内部整理 —— 无对外行为变化，通常只需在更新记录留一条',
};

function primaryDocRel(p) {
  if (p.techDocs) return p.techDocs;
  return (p.docs ?? []).find((rel) => !/readme/i.test(rel)) ?? '';
}

function changeBelongsToProject(change, p) {
  const norm = toPosix(change).toLowerCase();
  const dir = toPosix(p.dir).toLowerCase();
  return norm === dir || norm.startsWith(`${dir}/`) || norm.includes(`/${dir}/`);
}

/**
 * 选出本次该同步的文档。
 *
 * 分章文档集与单篇文档走两条路：
 *   - 分章集：按 frontmatter.files / 标题关键词选 1–3 章，并**始终带上 99 变更记录**；
 *   - 单篇：保持原来的文件级规则（API 完整文档、README…）。
 *
 * @returns {{picked: object[], missing: string[], tokens: string[]}}
 */
function pickDocTargets(root, keys, feature, changes, maxTargets) {
  const hay = `${feature}\n${changes.join('\n')}`;
  const tokens = featureTokens(feature, changes);
  const perProject = [];
  const missing = [];
  for (const key of keys) {
    const p = findProject(root, key);
    if (!p) continue;
    const dir = projectDir(root, p);
    const idx = getProjectDocs(root, p);
    const changedRel = changes.filter((c) => changeBelongsToProject(c, p)).map((c) => projectRelativeChange(c, p)).filter(Boolean);
    const setsByRel = new Map(idx.sets.map((s) => [s.rel, s]));
    const per = [];
    // 纯文档变更常常直接点名某一章：把它作为**强目标**，别让关键词兜底把 01 章顶上来。
    for (const rel of changedRel) {
      if (!/\.md$/i.test(rel)) continue;
      const direct = [...idx.chapterFiles, ...idx.changelogFiles].find(
        (f) => !f.isChangelog && projectRelativePath(root, p, f.abs) === rel,
      );
      if (!direct) continue;
      per.push({
        project: key,
        rel,
        abs: direct.abs,
        why: '本次直接改到的章节',
        kind: 'chapter',
        file: direct,
        score: 999,
        source: 0,
      });
    }
    const addChapterSet = (set, why) => {
      if (!set) return;
      const selected = selectChapterFiles(set, tokens, changedRel, 3);
      for (const item of selected) {
        if (per.some((t) => t.abs === item.file.abs)) continue;
        per.push({
          project: key,
          rel: projectRelativePath(root, p, item.file.abs),
          abs: item.file.abs,
          why,
          kind: 'chapter',
          file: item.file,
          score: item.score,
          source: item.source,
        });
      }
      const changelogs = set.changelogs ?? [];
      const latest = changelogs[changelogs.length - 1];
      if (latest && !per.some((t) => t.abs === latest.abs)) {
        const isVolume = changelogs.length > 1 || /\/99-[^/]*(变更记录|更新记录|changelog)\//i.test(toPosix(latest.rel));
        const nextEntry = Math.max(
          0,
          ...changelogs.flatMap((f) =>
            f.sections
              .map((s) => /^(\d{1,4})\s*[·.]/.exec(s.title))
              .filter(Boolean)
              .map((m) => Number(m[1])),
          ),
        ) + 1;
        const index = changelogs.find((f) => Number(f.num) === 0 || /索引|index/i.test(f.chapterTitle));
        per.push({
          project: key,
          rel: projectRelativePath(root, p, latest.abs),
          abs: latest.abs,
          why: isVolume
            ? '变更流水按卷写在 99-变更记录/ 的最新一卷（正文只留稳定结论）'
            : '变更流水统一写在 99 变更记录（正文只留稳定结论，正文不写「本轮」）',
          kind: 'changelog',
          file: latest,
          changelogStyle: isVolume ? 'volume' : 'date',
          changelogNext: nextEntry,
          ...(index ? { changelogIndexRel: projectRelativePath(root, p, index.abs) } : {}),
          score: 0,
          source: 0,
        });
      }
    };
    const addLegacy = (rel, why) => {
      if (!rel) return;
      const full = join(dir, rel);
      if (!existsSync(full)) {
        const tag = `${key}:${rel}`;
        if (!missing.includes(tag)) missing.push(tag);
        return;
      }
      if (per.some((t) => t.abs === full)) return;
      per.push({ project: key, rel, abs: full, why });
    };
    const resolveSpec = (spec, why) => {
      if (spec === '@tech') {
        if (idx.sets.length) {
          for (const set of idx.sets) addChapterSet(set, why);
          return;
        }
        const rel = primaryDocRel(p);
        if (rel) addLegacy(rel, why);
        return;
      }
      const full = join(dir, spec);
      let st;
      try {
        st = statSync(full);
      } catch {
        const tag = `${key}:${spec}`;
        if (!missing.includes(tag)) missing.push(tag);
        return;
      }
      if (st.isDirectory()) {
        const set = setsByRel.get(toPosix(spec).replace(/\/+$/, ''));
        if (set) addChapterSet(set, why);
        else {
          const found = idx.sets.find((s) => s.rel === spec || s.rel.startsWith(`${toPosix(spec)}/`));
          if (found) addChapterSet(found, why);
          else addLegacy(primaryDocRel(p), why);
        }
        return;
      }
      addLegacy(spec, why);
    };

    for (const rule of DOC_RULES) {
      if (!rule.when.test(hay)) continue;
      for (const spec of rule.docs[key] ?? []) resolveSpec(spec, rule.why);
    }
    // 一条规则都没命中时，退回该端技术文档（分章集则选总览章）。
    if (per.length === 0) {
      if (idx.sets.length) for (const set of idx.sets) addChapterSet(set, '该端技术文档（未命中具体规则时的兜底）');
      else {
        const rel = primaryDocRel(p);
        if (rel) addLegacy(rel, '该端主文档（未命中具体规则时的兜底）');
      }
    }
    // 选章在前、变更记录紧随第一张章：多端轮转时每一端的 99 都更容易拿到名额
    // （纯粹把 changelog 放末尾会被「3 章 + 99」的 desktop 吃掉全部 4 个名额）。
    const chapterTargets = per.filter((t) => t.kind !== 'changelog');
    const changelogTargets = per.filter((t) => t.kind === 'changelog');
    const ordered = [...chapterTargets.slice(0, 1), ...changelogTargets, ...chapterTargets.slice(1)];
    perProject.push(ordered.slice(0, 4));
  }
  // 跨端轮转取目标：不能因为 desktop 有 3 章 + 99 就把 4 个名额全吃掉，
  // 多端改动时每一端至少要有机会进清单。
  const picked = [];
  const cap = Math.max(1, maxTargets);
  for (let i = 0; picked.length < cap; i++) {
    let added = false;
    for (const list of perProject) {
      if (i >= list.length || picked.length >= cap) continue;
      picked.push(list[i]);
      added = true;
    }
    if (!added) break;
  }
  // 展示顺序：章在前、变更记录在后（选择顺序已保证名额分配）。
  picked.sort((a, b) => Number(a.kind === 'changelog') - Number(b.kind === 'changelog'));
  return { picked, missing, tokens };
}

// ─────────────────────────────────────────────────────────────────────────────
// iOS 构建 / 验证计划
//
// 为什么单独成组：media 是**跨两台机器**的双端项目 —— Windows 只能编 iOS klib，
// 链接 / Xcode 出包 / 模拟器自检只能在 macOS。这三件事的「能不能在本机跑」必须在
// 结果里说清楚，否则模型会把 mac 命令行丢到 Windows 上跑，或者在 Mac 上跑 assembleDebug
// （那台机器没装 Android SDK，必炸）。
//
// 全部命令与坑点的事实来源：kirara_media/app/docs/Kirara Media iOS P0 Mac 执行清单.md
// （§7 已知提示 / §9.7 没有 Simulator.app / §10–§11 主仓的构建与验收）
// 与 app/docs/Kirara Media 安卓版技术栈文档.md §67/§69。
// ─────────────────────────────────────────────────────────────────────────────

/** 一个 gradle 步骤：本机可执行的 { cmd, args } + 供人照抄的 mac 形式命令行。 */
function gradleStep(args) {
  const inv = gradleInvocation(args);
  return { cmd: inv.cmd, args: inv.args, line: `${inv.cmd} ${inv.args.join(' ')}`, macLine: `./gradlew ${args.join(' ')}` };
}

/**
 * 由 media.ios 组装出这一轮的 iOS 计划。
 * @param {object} ios - PROJECTS 里 media.ios。
 * @param {string} repoDir - media 仓库绝对路径。
 */
function iosPlan(ios, repoDir) {
  const evidence = join(repoDir, ios.evidenceDir);
  return {
    klib: gradleStep([...ios.klibTasks, '--console=plain']),
    link: gradleStep([...ios.linkTasks, '--console=plain']),
    // 脚本自带「构建 → 装模拟器 → 启动 → 截图 → 打印本次新增日志 → ✅/❌ 判定」，
    // 所以它就是 iOS 侧的 UI 验证执行体；用 bash 调起，不依赖可执行位。
    script: { cmd: 'bash', args: [ios.script], line: `bash ${ios.script}`, macLine: `bash ${ios.script}` },
    evidence,
    screenshots: ios.shots.map((s) => join(evidence, s)),
    logPath: `xcrun simctl get_app_container booted ${ios.bundleId} data/Documents/kirara.log`,
    runnableHere: IS_MAC,
    simGui: ios.simGui,
  };
}

/**
 * 展示用的构建命令行。
 *
 * media 是双端：Windows 上「Android 全量 + iOS klib 门禁」，macOS 上「klib → 链接 → 模拟器自检」。
 * 把「这条命令能不能在这台机器上跑」直接写进命令行文本，是防止后续模型把 mac 命令
 * 丢到 Windows 上跑（或反过来在没装 Android SDK 的 Mac 上跑 assembleDebug）最省成本的办法。
 */
function buildLineFor(p) {
  const base = `${p.build.cmd} ${p.build.args.join(' ')}`;
  if (!p.ios) return base;
  if (IS_MAC) {
    const plan = iosPlan(p.ios, '');
    return (
      `${plan.klib.macLine}（klib 门禁）→ ${plan.link.macLine}（链接）` +
      `→ ${plan.script.macLine}（模拟器自检 + 截图）`
    );
  }
  return (
    `${base}（Android） | iOS: ${p.build.cmd} ${p.ios.klibTasks.join(' ')}` +
    '（Windows 只能编 klib）；链接 / Xcode 出包 / 模拟器自检只能在 macOS'
  );
}

/**
 * 该端要读/要同步的文档。
 *
 * 分章文档集里**不列 13 个文件**：按请求关键词选 1–3 章（「先读哪几章」比「整本文档」有用），
 * 请求为空时只给一行目录指针，让模型用 kirara_docs mode=map 自己展开。
 * iOS 侧仍把 iOS 专篇排到前面（那几篇是 mac 环境的唯一事实来源）。
 */
function docsForProject(base, p, iosFocus, request = '') {
  const idx = getProjectDocs(base, p);
  const tokens = featureTokens(request, []);
  let main = [];
  if (idx.sets.length) {
    if (tokens.length) {
      const selected = [];
      for (const set of idx.sets) {
        for (const item of selectChapterFiles(set, tokens, [], 3)) {
          const rel = projectRelativePath(base, p, item.file.abs);
          if (!selected.includes(rel)) selected.push(rel);
        }
      }
      main = selected;
    }
    if (!main.length) {
      main = idx.sets.map((s) => `${s.rel}/（${s.chapters.filter((c) => !c.isChangelog).length} 章；kirara_docs mode=map）`);
    }
  } else {
    main = (p.docs ?? []).filter((rel) => existsSync(join(projectDir(base, p), rel)));
  }
  const loose = idx.loose
    .filter((f) => !/readme|license|许可协议|changelog|变更记录/i.test(f.rel))
    .map((f) => projectRelativePath(base, p, f.abs));
  const out = [...new Set([...main, ...loose])];
  if (p.ios && iosFocus) return [...p.ios.docs, ...out.filter((d) => !p.ios.docs.includes(d))].slice(0, 6);
  return out.slice(0, 6);
}

/**
 * iOS 自检脚本的判定行（`✅` / `❌` / `⚠️`）——脚本已经把「该看什么」写成了可读结论，
 * 这里只做搬运与预算收口，不重新解析日志格式（格式变了脚本会先红）。
 * @returns {string[]}
 */
function extractVerdicts(text, max = 6) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/[✅❌⚠️]/.test(line)) continue;
    if (out.includes(line)) continue;
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** 目录下匹配扩展名的文件（按名字排序，限数），用于收集模拟器截图。 */
function listScreenshots(dir, max = 8) {
  try {
    return readdirSync(dir)
      .filter((n) => /\.(png|jpe?g)$/i.test(n))
      .sort()
      .slice(0, max)
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 实时视觉迭代环（kirara_ui）—— 让「改界面」发生在看得见的状态下
//
// 为什么单独成组（2026-11，MCP 服务器更新后的第一轮）：
//   media 的 UI 改动在引入 MCP 之前的链路是「改代码 → 全量自检脚本(约 4 分钟) →
//   4 张固定截图 → 看着返工」。三个结构性浪费：
//     ① 截图是**构建脚本的副产物**，不是「我想看哪屏就看哪屏」—— 想验评论区抽屉，
//        只能改脚本或人肉点；
//     ② simctl 不能点击也不能打字（P0 清单 §9.7），所以「先走到目标界面再截图」
//        在 iOS 上原本无解，只能人肉开 DeviceHub；
//     ③ 一次「改 → 看」的反馈周期是整条自检脚本，而不是一张截图。
//   现在两个专用 MCP 服务把这三点补上了：
//     - Apple 官方 Xcode MCP（xcrun mcpbridge）的 mcp__xcode__DeviceInteractionSynthesize
//       能在模拟器上点按/输入并回传截图 + UI 层级，RenderPreview 能直接渲染 SwiftUI 预览；
//     - Android 侧的设备控制 MCP（adb-mcp / mobile-mcp 之类）提供截图 / 点击 / UI 树 / logcat。
//   但「能调」不等于「会调」：模型不知道本机装了哪个服务、工具叫什么、参数怎么填，
//   就会退回盲改。所以这组代码只做四件事，全部围绕「让环真的转起来」：
//     1. 发现（discover）：从 ctx.tools 读**当前真实存在**的工具名，认出哪些 MCP 命名空间
//        能截图 / 点按 / 出 UI 树 / 渲染预览。工具描述必须是字面量（见文件头的前缀缓存
//        契约），所以一切探测结果只出现在 execute() 的返回值里。
//     2. 兜底桥（bridge）：本机本来就装了 simctl / adb，截图这类事不必等 MCP ——
//        发现不到 MCP 时照样出图，环不因为「少装一个服务」停摆。
//     3. 证据链（evidence）：每张截图进 `<media>/iosApp/.tmp/ui-loop/` 并编号，
//        于是「这一轮到底看没看」是可验证的事实，而不是模型的自述。
//     4. 迭代计数（iteration）：review 带 issues 就记一轮、清空才算闭环；
//        kirara_verify / kirara_summary 会读这份状态，UI 改动没迭代过会被点名。
// ─────────────────────────────────────────────────────────────────────────────

/** 默认证据/状态目录（相对 media 仓库）：该目录在 media 的 .gitignore 里整棵忽略。 */
const UI_LOOP_REL_DIR = join('iosApp', '.tmp', 'ui-loop');

/**
 * Android 的 applicationId（**debug 变体**）。
 * app/build.gradle.kts 的 buildTypes.debug 里有 `applicationIdSuffix = ".debug"`，所以
 * debug 包名与 release 不同。装错变体最典型的症状是「改了半天、界面还是旧的」——
 * 一半是 Kirara_Media 用 debug 变体并存调试的设计，一半是命令写错了包名。
 */
const ANDROID_APP_ID = 'com.akeno6388.kirara.media.debug';

/** 看截图时逐条过的设计轴：要的是「下一步改哪一行」，不是审美评价。 */
const UI_REVIEW_AXES = [
  '对齐与间距：与同屏其他元素比差在哪、改成多少（dp/pt，别写「再大一点」）',
  '字号与层级：标题 / 正文 / 次要信息的字号字重颜色是否成阶梯',
  '对比度：深色档与浅色档各看一遍，正文与次要文字是否可读',
  '截断与溢出：长标题、长昵称、0 条与 99+ 条、空态与加载态',
  '材质与描边：玻璃档（SoftGlass / KiraraChromeStyle）是否与其余卡片同一张表',
  '触控热区：可点区域 ≥ 44pt，密集控件会不会互相误触',
  '状态完整性：禁用 / 选中 / 失败 / 网络错误各有对应视觉',
  '两端一致：同一屏 iOS 与 Android 的数值是否仍按同一张表（08.8 / 08.10）',
];

/** 视觉环的落点：配置里给了就用配置，否则 `<media>/iosApp/.tmp/ui-loop`。 */
function uiLoopRoot(base, p, override) {
  const raw = typeof override === 'string' ? override.trim() : '';
  if (raw) return resolve(expandHome(raw));
  // 仓库目录名按 PROJECTS 写的是 `Kirara_Media`，但克隆到大小写敏感的文件系统上时可能叫
  // `kirara_media`（本机 macOS 不区分大小写，所以平时看不出来）。这里取真实存在的那个，
  // 否则会在旁边凭空造一个 Kirara_Media/ 空壳目录，证据就落在没人会看的地方了。
  const declared = projectDir(base, p);
  if (existsSync(declared)) return join(declared, UI_LOOP_REL_DIR);
  const lowered = join(base, p.dir.toLowerCase());
  if (existsSync(lowered)) return join(lowered, UI_LOOP_REL_DIR);
  return join(declared, UI_LOOP_REL_DIR);
}

/** 状态文件路径。 */
function uiStatePath(root) {
  return join(root, 'state.json');
}

/**
 * 读一轮环的状态（不存在/损坏都返回空状态：坏状态不该让环停摆）。
 * @param {string} file
 * @param {string} platform
 */
function readUiState(file, platform) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.shots)) return parsed;
  } catch {
    /* 首次运行 / 文件坏了：都按空状态起步 */
  }
  return {
    v: 1,
    platform,
    startedAt: new Date().toISOString(),
    iterations: 0,
    shots: [],
    openIssues: [],
    lastReviewAt: '',
  };
}

/** 写状态；失败只影响「证据链可查」，不影响本次截图本身，所以吞掉异常并返回 false。 */
function writeUiState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * 闭环判据（只读，供 kirara_verify / kirara_summary 与 kirara_ui status 共用）。
 * 「闭环」= 至少看过 1 张截图 + 至少走过 1 轮 review + 手上没有未修的 P0/P1。
 */
function readUiLoopSummary(base, p, override) {
  const root = uiLoopRoot(base, p, override);
  const state = readUiState(uiStatePath(root), 'auto');
  const shots = Array.isArray(state.shots) ? state.shots : [];
  const openIssues = Array.isArray(state.openIssues) ? state.openIssues : [];
  const iterations = Number(state.iterations) || 0;
  return {
    root,
    platform: typeof state.platform === 'string' ? state.platform : '',
    shots: shots.length,
    iterations,
    openIssues,
    closed: shots.length > 0 && iterations > 0 && openIssues.length === 0,
  };
}

/**
 * 跑一个「把 stdout 当二进制写进文件」的子进程。
 * 为什么不用 runProcess：那个把 stdout 当 UTF-8 字符串拼；`adb exec-out screencap -p`
 * 吐的是 PNG，按字符串解码再编码出来是坏图，而且**不会报错** —— 坏的取证比没有更糟。
 * @returns {Promise<{ok: boolean, code: number|null, timedOut: boolean, stderr: string, durationMs: number}>}
 */
function runProcessToFile(cmd, args, cwd, timeoutMs, outFile) {
  return new Promise((res) => {
    const started = Date.now();
    let stderr = '';
    let settled = false;
    let child;
    let stream;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ ...result, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* 忽略 */
      }
      try {
        stream?.end();
      } catch {
        /* 忽略 */
      }
      finish({ ok: false, code: null, timedOut: true, stderr });
    }, timeoutMs);
    try {
      stream = createWriteStream(outFile);
      child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env } });
    } catch (err) {
      finish({ ok: false, code: null, timedOut: false, stderr: String(err?.message ?? err) });
      return;
    }
    child.stdout?.pipe(stream);
    child.stderr?.on('data', (b) => {
      stderr += b.toString();
    });
    child.on('error', (err) => {
      finish({ ok: false, code: null, timedOut: false, stderr: stderr + String(err?.message ?? err) });
    });
    child.on('close', (code) => {
      // 等管道把最后一个字节落盘再收尾，否则紧接着读文件可能拿到截断的 PNG。
      stream?.end(() => finish({ ok: code === 0, code, timedOut: false, stderr }));
    });
  });
}

/**
 * 解析 `xcrun simctl list devices -j`，挑一台能用的模拟器。
 * 优先级：配置指定的名字 → booted 的 iPhone → 任意 booted → 第一台可用 iPhone。
 * 为什么优先 booted 而不是配置里的 `iPhone 18 Pro`：那个写死的名字在本机不存在
 * （只有 18 Pro Max），xcodebuild 会回落 "My Mac" 并报 doesn't match 平台。
 */
function pickSimulator(jsonText, preferred) {
  let data;
  try {
    data = JSON.parse(String(jsonText || ''));
  } catch {
    return null;
  }
  const all = [];
  for (const list of Object.values(data?.devices ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      if (!d || typeof d.udid !== 'string' || d.isAvailable === false) continue;
      all.push({ udid: d.udid, name: String(d.name ?? ''), state: String(d.state ?? '') });
    }
  }
  const iPhones = all.filter((d) => /iphone/i.test(d.name));
  const want = String(preferred || '').trim();
  const picked =
    (want ? all.find((d) => d.name === want) : undefined) ??
    iPhones.find((d) => /booted/i.test(d.state)) ??
    all.find((d) => /booted/i.test(d.state)) ??
    iPhones[0] ??
    all[0];
  return picked ?? null;
}

/** 解析 `adb devices` 的表格（第一行是表头）。 */
function parseAdbDevices(text) {
  return String(text || '')
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial: String(serial || ''), state: String(state || '') };
    })
    .filter((d) => d.serial && d.state);
}

/** Android SDK 根：环境变量优先，其次三个常见安装位置（macOS / Linux / Windows）。 */
function androidSdkRoot() {
  const fromEnv = String(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '').trim();
  if (fromEnv) return expandHome(fromEnv);
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    join(home, 'Library', 'Android', 'sdk'),
    join(home, 'Android', 'Sdk'),
    join(home, 'AppData', 'Local', 'Android', 'Sdk'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

/** adb 可执行文件：SDK 下那个绝对路径优先，找不到就退回 PATH 上的名字。 */
function adbExe() {
  const sdk = androidSdkRoot();
  const candidates = sdk ? [join(sdk, 'platform-tools', IS_WIN ? 'adb.exe' : 'adb')] : [];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return IS_WIN ? 'adb.exe' : 'adb';
}

/**
 * 从**当前真实可用**的工具名里认出「设备控制类」MCP 命名空间。
 *
 * 纯函数：输入是从 `ctx.tools.definitions()` 抽出来的名字数组，夹具可以直接喂。
 * 只输出四类能驱动视觉环的能力（截图 / 点按 / UI 树 / 预览），不把 81 个名字全倒出来 ——
 * 返回值会永久留在上下文里，倒全表等于每轮多背一份工具目录。
 * @param {string[]} toolNames - 形如 `mcp__xcode__RenderPreview`。
 * @returns {Array<{namespace: string, tools: number, screenshot?: string, driver?: string, uiTree?: string, preview?: string, app?: string}>}
 */
function discoverUiMcp(toolNames) {
  const byNamespace = new Map();
  for (const raw of Array.isArray(toolNames) ? toolNames : []) {
    if (typeof raw !== 'string' || !raw.startsWith('mcp__')) continue;
    const rest = raw.slice(5);
    const sep = rest.indexOf('__');
    if (sep <= 0) continue;
    const namespace = rest.slice(0, sep);
    const name = rest.slice(sep + 2);
    if (!namespace || !name) continue;
    if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
    byNamespace.get(namespace).push({ name, full: raw });
  }
  const pick = (list, re) => list.find((t) => re.test(t.name))?.full;
  const out = [];
  for (const [namespace, list] of byNamespace) {
    const screenshot = pick(list, /screenshot|capture|snapshot/i);
    // 「点按/输入」这一格要挑**真正执行手势**的那个，而不是会话管理：
    // Xcode MCP 里同时有 DeviceInteractionStartSession / DeviceInteractionSynthesize，
    // 名字都含 interaction，但只有 Synthesize 接受 't x y' 这种命令。所以按精确度排序挑。
    const driver =
      pick(list, /synthesize/i) ??
      pick(list, /(^|_|-)tap|click|swipe/i) ??
      pick(list, /interaction|gesture/i);
    const uiTree = pick(list, /ui_?tree|hierarchy|describe_ui|elements_on_screen/i);
    const preview = pick(list, /preview/i);
    const app = pick(list, /installandrun/i) ?? pick(list, /install|launch|run_?project/i);
    // 一个只有 build/log 的服务不参与视觉环（Xcode MCP 正好两者都全，所以会出现）。
    if (!screenshot && !driver && !uiTree && !preview) continue;
    out.push({
      namespace,
      tools: list.length,
      ...(screenshot ? { screenshot } : {}),
      ...(driver ? { driver } : {}),
      ...(uiTree ? { uiTree } : {}),
      ...(preview ? { preview } : {}),
      ...(app ? { app } : {}),
    });
  }
  return out;
}

/** 把发现结果压成给人看的一行（返回值里每个命名空间一行）。 */
function describeUiMcp(entry) {
  const caps = [
    entry.screenshot && `截图=${entry.screenshot}`,
    entry.driver && `点按/输入=${entry.driver}`,
    entry.uiTree && `UI树=${entry.uiTree}`,
    entry.preview && `预览=${entry.preview}`,
    entry.app && `装/启=${entry.app}`,
  ].filter(Boolean);
  return `${entry.namespace}（${entry.tools} 个工具）: ${caps.join(' | ')}`;
}

/** 子进程的 cwd：给的目录不存在时退回当前目录（spawn 的 cwd 不存在会 ENOENT，容易被误读成「工具没装」）。 */
function shellCwd(dir) {
  return existsSync(dir) ? dir : undefined;
}

/** 探测 iOS 设备（只读命令，失败也回结构化结果而不是抛）。 */
async function probeIosDevice(dir, timeoutMs, preferred) {
  const command = 'xcrun simctl list devices -j';
  const listed = await runProcess('xcrun', ['simctl', 'list', 'devices', '-j'], shellCwd(dir), Math.min(timeoutMs, 30000));
  if (!listed.ok) {
    return {
      platform: 'ios',
      ok: false,
      command,
      error: `xcrun 不可用或未装 Xcode：${tail(listed.stderr || listed.stdout, 3).trim() || 'no output'}`,
    };
  }
  const sim = pickSimulator(listed.stdout, preferred);
  if (!sim) {
    return { platform: 'ios', ok: false, command, error: '本机没有可用模拟器：先在 Xcode → Settings → Components 装一个 iOS 运行时' };
  }
  return {
    platform: 'ios',
    ok: true,
    command,
    udid: sim.udid,
    name: sim.name,
    state: sim.state,
    booted: /booted/i.test(sim.state),
  };
}

/** 探测 Android 设备（同样只读）。 */
async function probeAndroidDevice(dir, timeoutMs) {
  const exe = adbExe();
  const command = `${exe} devices`;
  const listed = await runProcess(exe, ['devices'], shellCwd(dir), Math.min(timeoutMs, 30000));
  if (!listed.ok) {
    const detail = (listed.stderr || listed.stdout || '').trim().split(/\r?\n/).slice(0, 1).join('');
    return {
      platform: 'android',
      ok: false,
      command,
      error:
        'adb 不可用：装 Android SDK Platform-Tools，或把 ANDROID_HOME 指到 SDK 根目录' +
        (detail ? `（原始输出：${detail.slice(0, 120)}）` : ''),
    };
  }
  const devices = parseAdbDevices(listed.stdout).filter((d) => /device|offline|unauthorized/i.test(d.state));
  const online = devices.filter((d) => d.state === 'device');
  if (!online.length) {
    return {
      platform: 'android',
      ok: false,
      command,
      adb: exe,
      error: devices.length
        ? `有设备但不可用（${devices.map((d) => `${d.serial}=${d.state}`).join(', ')}）：手机上点「允许 USB 调试」，或换一根数据线`
        : '本机没有在线的 Android 设备：插真机并开 USB 调试，或装 emulator 组件 + 建一台 AVD',
    };
  }
  return { platform: 'android', ok: true, command, adb: exe, serial: online[0].serial, devices: online.map((d) => d.serial) };
}

/** 截一张图落盘；iOS 走 simctl，Android 走二进制管道。 */
async function captureShot(device, file, dir, timeoutMs) {
  if (device.platform === 'ios') {
    const res = await runProcess('xcrun', ['simctl', 'io', device.udid, 'screenshot', file], shellCwd(dir), timeoutMs);
    if (res.ok && existsSync(file)) return { ok: true, file };
    return { ok: false, file, error: tail(res.stderr || res.stdout, 3).trim() || 'simctl screenshot 无输出' };
  }
  const res = await runProcessToFile(device.adb, ['-s', device.serial, 'exec-out', 'screencap', '-p'], shellCwd(dir), timeoutMs, file);
  if (res.ok && existsSync(file)) return { ok: true, file };
  return { ok: false, file, error: tail(res.stderr, 3).trim() || `adb screencap 退出码 ${res.code ?? 'n/a'}` };
}

/** 证据目录里下一个可用编号（先看已有文件，再退回状态里的计数，避免覆盖旧证据）。 */
function nextShotIndex(root, existing) {
  let max = Number(existing) || 0;
  try {
    for (const name of readdirSync(root)) {
      const m = /^shot-(\d+)\./i.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {
    /* 目录还不存在：从 1 开始 */
  }
  return max + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// apply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 注册 Kirara 开发流程工具。
 * @param {object} ctx - 携带 tools 注册表的上下文。
 * @param {object} config - 部署配置（workspaceRoot / buildTimeoutMs / buildLogTailLines）。
 */
export function apply(ctx, config) {
  const root = () => resolveRoot(config);
  // 全部用 `?? 默认值`：夹具/测试常只传部分 config，schemastery 的默认值不会补上。
  const logTail = config.buildLogTailLines ?? 25;
  const buildLineChars = config.buildLogLineChars ?? 300;
  const buildBudget = config.buildBudgetChars ?? 5000;
  const docsMaxHits = config.docsMaxHits ?? 12;
  const docsLineChars = config.docsLineChars ?? 200;
  const docsBudget = config.docsBudgetChars ?? 4000;
  const textBudget = config.textBudgetChars ?? 2400;
  const docsyncBudget = config.docsyncBudgetChars ?? 2400;
  const docsyncMaxTargets = config.docsyncMaxTargets ?? 4;
  const timeoutMs = config.buildTimeoutMs ?? 1200000;
  const releaseTimeout = config.releaseTimeoutMs ?? 2400000;
  const releaseBudget = config.releaseBudgetChars ?? 3000;
  const notesMaxCommits = config.releaseNotesMaxCommits ?? 40;
  const notesMaxFiles = config.releaseNotesMaxFiles ?? 25;
  const notesBudget = config.releaseNotesBudgetChars ?? 3200;
  const configuredOutputDir = config.releaseOutputDir ?? '';
  const uiBudget = config.uiLoopBudgetChars ?? 2600;
  const maxShots = Math.max(1, config.uiLoopMaxShots ?? 6);

  // 可选：把配置里指定的设备控制 MCP 交给宿主托管（ctx.mcpManager.register）。
  //
  // 三条刻意的边界：
  //   ① 没配 command 就**什么都不做**：本机没有 npm/npx，自动下载第三方服务器不是插件的职责；
  //   ② 用 ctx.inject(['mcpManager'], …) 而不是把 mcpManager 写进 inject 数组 ——
  //      后者在没挂 mcp-manager 的 profile 上会让整个插件挂不上，而视觉环只是其中一项能力；
  //   ③ 注册是 effect：插件卸载即摘除，不会在 profile 里留下一个孤儿服务器。
  const uiMcpServer = String(config.uiMcpServer || '').trim();
  const uiMcpCommand = String(config.uiMcpCommand || '').trim();
  if (uiMcpServer && uiMcpCommand) {
    const uiMcpArgs = String(config.uiMcpArgs || '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      ctx.inject(['mcpManager'], (child) => {
        child.effect(
          () => child.mcpManager.register(uiMcpServer, { transport: 'stdio', command: uiMcpCommand, args: uiMcpArgs }),
          'kirara-dev:ui-mcp',
        );
      });
    } catch (error) {
      // 注册失败不影响视觉环：simctl / adb 兜底桥仍在，发现逻辑也会自己找出真实可用的服务。
      console.error('[kirara-dev] 注册设备控制 MCP 失败（视觉环仍可用 simctl/adb 兜底）：', error);
    }
  }

  /**
   * 名义工具集合，仅用于启动后自检。
   * 为什么需要它：工具集合一旦与上次启动不同（新增/删除/改名/改描述/换顺序都算），
   * DSH 会记一条 `request/header` reason=change 并开启新的 request series，
   * 而 SystemPromptProjection 在 startsSeries 时是**原地改写**系统提示节点（对话第一条
   * system 消息）——整段前缀缓存当场作废。所以要能一眼看出集合是否走样。
   */
  const NOMINAL_TOOLS = [
    'kirara_start',
    'kirara_profile',
    'kirara_docs',
    'kirara_route',
    'kirara_build',
    'kirara_verify',
    'kirara_summary',
    // 追加在末尾是有意的：注册顺序 = DSH 记进 request/header 的工具顺序，
    // 插在中间会让快照变动更多（反正新增工具本就会换一次快照，见文件头的前缀缓存契约）。
    'kirara_docsync',
    // 发布链路（2026-10 新增）：先出素材 → 写 README → 再打包发布。
    // 同样追加在末尾：注册顺序就是 DSH 记进 request/header 的工具顺序。
    'kirara_release_notes',
    'kirara_release',
    // 实时视觉迭代环（2026-11 新增，随 MCP 服务器更新而来）：把「改界面」从
    // 「构建 → 全量自检截图 → 返工」改成「看一眼 → 改 → 再看一眼」。
    'kirara_ui',
  ];
  const registered = [];

  // 逐个隔离注册：defineTool() 会**立即**编译参数 schema 并校验视图形状，
  // 任何 DSL 违规都在这里抛出。若让它一口气跑完，一个写错的工具会让 8 个全丢，
  // 而插件整体 apply() 失败还会被宿主当成挂载错误。所以失败者只记日志、不扩散。
  const failed = [];
  const guard = (toolName, factory) => {
    try {
      // ctx.tools.register() 在 DSH 内部已经是 scope 化的 effect（注册即绑定到本插件
      // 的 fiber，插件卸载时自动注销），所以这里不需要再包一层 ctx.effect。
      ctx.tools.register(factory());
      registered.push(toolName);
    } catch (error) {
      failed.push(toolName);
      console.error(`[kirara-dev] 注册 ${toolName} 失败，其余工具继续注册：`, error);
    }
  };

  // ── 0. kirara_start ────────────────────────────────────────────────────────
  // 一句话启动开发：这是整个流程的自然入口，也是「小功能一句话启动」的代码级落实。
  // 它只做第 1+2 阶段（解读 + 定路线）并把第 3 阶段该读什么、该建什么端到端串好；
  // 真正的代码修改仍由模型完成 —— 工具不臆造业务代码。
  guard('kirara_start', () =>
    defineTool({
      name: 'kirara_start',
      description:
        'Kirara dev entry point. Pass the user\'s one-line request; returns the involved sub-projects, the docs to read first, the exact per-project build commands, whether live-device verification is needed, and any decision the human must make. ' +
        'mode=auto decides docs/full/small (docs = markdown-only change: no build, no device check). ' +
        'If blocked=true, call ask_user_question before writing any code.',
      parameters: {
        request: {
          type: 'string',
          required: true,
          description: 'The user\'s one-line feature/fix request, verbatim (Chinese is fine).',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'docs', 'small', 'full'],
          description:
            'auto (default) = decide from the request; docs = 纯文档变更（改/同步 .md，免构建、免实机验证）；' +
            'small = 一句话小功能，构建成功即完成；full = 需要实机验证。' +
            ' 注意：请求命中界面/交互关键词时 auto 不会选 small（构建通过 ≠ 效果正确）；' +
            '「改文档」类请求词表刻意保守，漏判时显式传 docs。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            request: { type: 'string', required: true },
            mode: { type: 'string', required: true },
            modeWhy: { type: 'string', required: true },
            reasons: { type: 'array', required: true, items: { type: 'string' } },
            targets: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            docsToRead: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            blocked: { type: 'boolean', required: true },
            docsOnly: { type: 'boolean', required: true },
            decisions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            steps: { type: 'array', required: true, items: { type: 'string' } },
            nextAction: { type: 'string', required: true },
          },
        },
        render: (_args, v) => {
          const body =
            // 不再回显整条需求：模型刚把 request 传进来，原样重放只是重复占上下文。
            `🚀 ${v.request.length > 60 ? `${v.request.slice(0, 60)}…` : v.request}\n` +
            `mode=${v.mode}（${v.modeWhy}）\n` +
            (v.reasons?.length ? `判定依据: ${v.reasons.join('；')}\n` : '') +
            `涉及端: ${v.targets.map((t) => `${t.key}(${t.title})`).join(', ')}\n` +
            `先读文档:\n` +
            v.docsToRead.map((d) => `  - ${d.project}: ${d.docs.join(' , ')}`).join('\n') +
            (v.docsOnly
              ? `\n构建命令: （纯文档变更，本轮不构建）\n`
              : `\n构建命令:\n` + v.targets.map((t) => `  - ${t.key}: ${t.buildLine}`).join('\n')) +
            `\n流程:\n` +
            v.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n') +
            (v.blocked
              ? `\n⛔ 阻塞项 —— 必须先 ask_user_question 挂起:\n` +
                v.decisions.filter((d) => d.blocking).map((d) => `  - ${d.question}`).join('\n')
              : '');
          return [{ type: 'text', text: clampText(body, textBudget) }];
        },
      },
      execute(args) {
        const request = String(args.request || '').trim();
        if (!request) {
          return Promise.resolve({
            request: '',
            mode: 'small',
            modeWhy: '请求为空，无从路由。',
            reasons: [],
            targets: [],
            docsToRead: [],
            blocked: true,
            docsOnly: false,
            decisions: [
              {
                id: 'empty-request',
                blocking: true,
                question: '没有收到具体需求描述，请补充一句话说明要做什么。',
                options: [],
                recommend: '',
              },
            ],
            steps: [],
            nextAction: 'STOP：先向用户追问具体需求。',
          });
        }

        const wantAuto = !args.mode || args.mode === 'auto';
        // 先按 full + docs 探一遍：只要出现阻塞项、需要看实机效果，或本身就是纯文档变更，
        // 就不能按「小功能」草率放过。
        const probe = routeRequest(request, { docs: args.mode === 'docs' });
        const blocked = probe.decisions.some((d) => d.blocking);
        const mode = wantAuto
          ? probe.docsOnly
            ? 'docs'
            : blocked || probe.deviceRequired
              ? 'full'
              : 'small'
          : args.mode;
        const small = mode === 'small';
        const docsOnly = mode === 'docs';

        // small 模式下重新取一次决策（避免把 media 的实机问询算成决策噪声）
        const final = small ? routeRequest(request, { small: true }) : probe;
        const { keys, decisions } = final;
        const uiChange = final.uiChange;
        // media 的 iOS 侧：路由命中了 iOS 词族时为 true。它只影响「读哪几篇文档 + 加哪一步流程」，
        // 不改变端归属（Android / iOS 共用 media 这一端与同一批 :shared 代码）。
        const iosFocus = final.iosFocus === true && keys.includes('media');

        const targets = keys.map((k) => {
          const p = findProject(root(), k);
          return {
            key: p.key,
            title: p.title,
            dir: p.dir,
            buildLine: buildLineFor(p),
            apk: p.apk ?? null,
            ...(p.ios
              ? {
                  platforms: ['android', 'ios'],
                  iosTargets: p.ios.targets,
                  versionLock: p.ios.versionLock,
                }
              : {}),
          };
        });

        // 该先读哪些文档：优先读「哪端改就读哪端」，而不是把 258 KB 全塞进上下文。
        // 纯文档变更时改读 kirara_docsync 选出的**具体目标文档** —— 那才是本轮要动的东西。
        let docsToRead = [];
        if (docsOnly) {
          const { picked } = pickDocTargets(root(), keys, request, [], docsyncMaxTargets);
          const grouped = new Map();
          for (const t of picked) {
            if (!grouped.has(t.project)) grouped.set(t.project, []);
            grouped.get(t.project).push(t.rel);
          }
          docsToRead = [...grouped].map(([k, docs]) => ({
            project: k,
            dir: findProject(root(), k).dir,
            docs,
          }));
        }
        if (docsToRead.length === 0) {
          docsToRead = keys
            .map((k) => findProject(root(), k))
            .map((p) => ({
              project: p.key,
              dir: p.dir,
              docs: docsForProject(root(), p, iosFocus, request).slice(0, 4),
            }));
        }

        // 流程说明是「每次调用都会重放进上下文」的内容，所以刻意压成短句：
        // 原版 6 条中文长句 ≈500 字符，每次调用都重复一遍。
        const steps = docsOnly
          ? [
              'kirara_docs 检索上面列出的目标文档现状（不要整篇读）',
              '直接编辑 .md —— 纯文档变更：不构建、不实机验证',
              'kirara_docsync 判断该同步哪几篇 + 每篇改哪些章节',
              'kirara_summary(mode=docs) 收尾',
            ]
          : [
              'kirara_docs 按关键词检索上面列出的文档（不要整篇读）',
              blocked ? '先 ask_user_question 挂起，拿到答复再动手' : '无阻塞项，直接开发',
              '按各端约束改代码（约束用 kirara_profile 取）',
              `kirara_build 逐端验证：${keys.join(' → ')}`,
              // iOS 侧的核心差异：验证做在模拟器上（Windows 只能先编 klib）。
              // 这条**只**在请求命中 iOS 词族时出现 —— 纯 Android 请求不该被塞 mac 命令。
              ...(iosFocus
                ? [
                    'iOS: 先 kirara_build({project:"media",target:"ios-klib"}) 编 klib（Windows 也能跑）；' +
                      '链接/出包/模拟器自检必须在 macOS 上 target=ios（一条命令出构建+截图+✅/❌）',
                  ]
                : []),
              small
                ? 'mode=small：构建成功即结束，不做实机验证'
                : 'kirara_verify 产出分步实机测试清单交用户执行',
              // UI 改动的截图复核是必经环节：不看截图就改样式等于盲改。
              // 2026-11 起入口换成 kirara_ui（实时视觉环）：它把「构建 → 全量自检截图」的
              // 反馈周期压成「截一张图」，并顺手检查这一轮到底有没有人看过界面。
              ...(uiChange
                ? [
                    iosFocus
                      ? 'UI 内环：kirara_ui(action="plan") 先发现 MCP/设备 → shot → 看图改 → review；收敛后再 kirara_build(target=ios) + kirara_verify(ui-design) 收尾'
                      : 'UI 内环：kirara_ui(action="plan") → shot → 看图改 → review；收敛后再 kirara_build + kirara_verify(purpose=ui-design) 收尾',
                  ]
                : []),
              'kirara_docsync 判断该同步哪几篇 docs/ 下的 md，并按它的清单更新',
              'kirara_summary 收尾（把改过的文档一并记上）',
            ];

        return Promise.resolve({
          request,
          mode,
          modeWhy: wantAuto
            ? docsOnly
              ? '自动判定：请求只涉及文档编写/同步（文档动作 ∧ 文档对象，且无代码对象）⇒ 免构建、免实机验证。'
              : blocked
                ? '自动判定：检测到阻塞性决策，按 full 处理（需实机验证 + 先拍板）。'
                : probe.deviceRequired
                  ? '自动判定：请求涉及用户可见效果，不能按 small 处理（构建通过 ≠ 效果正确）。'
                  : '自动判定：无阻塞项、未命中界面/交互信号，按 small 处理（构建成功即完成）。' +
                    '⚠️ 自动判定可能漏判：若本次改动实际有用户可见效果，显式传 mode=full 覆盖。'
            : `显式指定 mode=${mode}（${docsOnly ? '纯文档变更，免构建' : small ? '构建成功即完成' : '需实机验证'}）。`,
          docsOnly,
          reasons: final.reasons,
          targets,
          docsToRead,
          blocked,
          decisions,
          steps,
          nextAction: blocked
            ? 'STOP：调用 ask_user_question 挂起，禁止先写代码。'
            : docsOnly
              ? '按 docsToRead 逐篇编辑；纯文档变更不需要 kirara_build。'
              : iosFocus
                ? `先改代码；Windows 侧用 kirara_build({project:'media',target:'ios-klib'}) 当门禁，` +
                  `链接/出包/模拟器截图与 ${keys.join('/')} 的其余验证按上面的步骤走。`
                : `开始改代码；改完用 kirara_build 验证 ${keys.join('/')}，再用 kirara_docsync 定文档。`,
        });
      },
      presentCall: (args) => ({ card: 'generic', title: '🚀 一句话启动开发', kind: 'other', rawInput: args.request }),
    }),
  );

  // ── 1. kirara_profile ──────────────────────────────────────────────────────
  guard('kirara_profile', () =>
    defineTool({
      name: 'kirara_profile',
      description:
        'Kirara project profile: the three sub-projects, their exact build/run commands, hard constraints, and the process-cleanup safety rules. ' +
        'Use this instead of reading the very large in-repo docs (single tech docs exceed 200 KB). Pass project to narrow it to one end.',
      parameters: {
        project: {
          type: 'string',
          description: 'Optional: return only one sub-project: desktop | api | media.',
          enum: ['desktop', 'api', 'media'],
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspaceRoot: { type: 'string', required: true },
            projects: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            safetyRules: { type: 'array', required: true, items: { type: 'string' } },
            workflow: { type: 'array', required: true, items: { type: 'string' } },
            missing: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const body =
            `Kirara profile @ ${value.workspaceRoot}\n` +
            value.projects
              .map(
                (p) =>
                  `- [${p.key}] ${p.title}\n    build: ${p.buildLine}\n` +
                  // media 是双端：iOS 那三条事实（只能在哪跑 / 版本锁 / 怎么取证）必须随画像一起给，
                  // 否则模型会拿 Android 的验证方式去验 iOS 界面。
                  (p.ios
                    ? `    ios: ${p.ios.klibLine}\n` +
                      `         ${p.ios.macLine}\n` +
                      `         ${p.ios.versionLock}\n`
                    : '') +
                  `    docs:  ${(p.docs || []).join(', ')}`,
              )
              .join('\n') +
            (value.missing.length ? `\n缺失目录: ${value.missing.join(', ')}` : '');
          return [{ type: 'text', text: clampText(body, textBudget) }];
        },
      },
      execute(args) {
        const base = root();
        const wanted = args.project
          ? PROJECTS.filter((p) => p.key === args.project)
          : PROJECTS;
        const missing = [];
        const projects = wanted.map((p) => {
          const dir = projectDir(base, p);
          if (!existsSync(dir)) missing.push(p.dir);
          return {
            key: p.key,
            title: p.title,
            dir,
            stack: p.stack,
            tfm: p.tfm ?? null,
            buildLine: buildLineFor(p),
            build: p.build,
            publish: p.publish ?? null,
            run: p.run ?? null,
            apk: p.apk ?? null,
            specs: p.specs,
            docs: docsForProject(base, p, false, ''),
            constraints: p.constraints,
            // iOS 三条事实的展示形态在这里定型（渲染与返回值共用同一份，避免两处漂移）。
            ...(p.ios
              ? {
                  ios: {
                    title: p.ios.title,
                    bundleId: p.ios.bundleId,
                    targets: p.ios.targets,
                    versionLock: p.ios.versionLock,
                    klibLine: `klib 门禁 ${p.build.cmd} ${p.ios.klibTasks.join(' ')}（Windows 也能跑，抓 iOS 侧 API 不存在）`,
                    macLine:
                      `链接 / 出包 / 模拟器自检仅 macOS：${iosPlan(p.ios, dir).script.line}（设备 ${p.ios.device}，` +
                      `截图落 ${p.ios.evidenceDir}）`,
                    device: p.ios.device,
                    evidenceDir: p.ios.evidenceDir,
                    simGui: p.ios.simGui,
                    javaHome: p.ios.javaHome,
                    pitfalls: p.ios.pitfalls,
                    docs: p.ios.docs,
                  },
                }
              : {}),
            present: existsSync(dir),
          };
        });
        return Promise.resolve({
          workspaceRoot: base,
          projects,
          safetyRules: SAFETY_RULES,
          workflow: [
            '1. interpret — 读画像 + kirara_docs 检索，确定涉及端与影响面',
            '2. route — kirara_start 定路线：docs（纯 md / 免构建）、small（构建成功即完成）、full（需实机验证）',
            '3. 若需要用户拍板：不要猜，用内置 ask_user_question 挂起提问',
            '4. develop — 按约束改代码；纯文档变更直接改 md',
            '5. build — kirara_build 构建验证；mode=docs 不构建，mode=small 构建成功即结束',
            '6. verify — kirara_verify 产出分步测试清单；UI 改动必经截图复核（purpose=ui-design）',
            '7. docsync — kirara_docsync 判断并同步 docs/ 下的 md：新功能 / BUG 修复都要走',
            '8. summary — kirara_summary 汇总变更/构建/清单/已同步文档/遗留风险',
          ],
          missing,
        });
      },
      presentCall: () => ({ card: 'generic', title: '读取 Kirara 项目画像', kind: 'read' }),
    }),
  );

  // ── 2. kirara_docs ─────────────────────────────────────────────────────────
  guard('kirara_docs', () =>
    defineTool({
      name: 'kirara_docs',
      description:
        'Chapter-aware technical-doc search. mode=search (default): keyword hits with chapter/section/anchor; mode=map: chapter + section map (start here when unsure); mode=section: read one section by "NN.M", anchor or title. ' +
        'Use it instead of reading whole files (some are 200 KB+); narrow with project/chapter/file when truncated.',
      parameters: {
        mode: {
          type: 'string',
          enum: ['search', 'map', 'section'],
          description: 'search = keyword hits (default); map = chapter/section directory; section = read one section.',
        },
        keywords: {
          type: 'array',
          description: 'search mode: keywords to search for (case-insensitive, OR-matched). CJK substrings work.',
          items: { type: 'string' },
        },
        project: {
          type: 'string',
          description: 'Optional: restrict to one sub-project: desktop | api | media.',
          enum: ['desktop', 'api', 'media'],
        },
        chapter: {
          type: 'string',
          description: 'Optional: chapter filter, e.g. "03", "认证", or file name — also narrows map/section.',
        },
        section: {
          type: 'string',
          description: 'mode=section: "03.2", anchor ("auth"), or a title substring.',
        },
        file: {
          type: 'string',
          description: 'Optional: restrict to one file (path relative to workspace root, or a substring of it).',
        },
        maxHits: {
          type: 'integer',
          description:
            'Max matching lines to return. Defaults to 12. The whole result is additionally capped by a character budget, so prefer narrower keywords over a bigger number.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', required: true },
            hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            scannedFiles: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
            chapters: { type: 'array', items: { type: 'object', additionalProperties: true } },
            section: { type: 'object', additionalProperties: true },
            warnings: { type: 'array', items: { type: 'string' } },
            next: { type: 'string' },
          },
        },
        render: (args, value) => {
          if (value.mode === 'map') {
            if (!value.chapters?.length) {
              return [{ type: 'text', text: value.next || '未找到分章文档集或单篇文档：检查 workspaceRoot / project。' }];
            }
            const lines = [`📚 文档结构（扫描 ${value.scannedFiles} 个文件）`];
            for (const g of value.chapters || []) {
              if (g.loose) {
                lines.push(`  [${g.project}] ${g.rel}（单篇 · ${g.sections} 节）`);
                continue;
              }
              lines.push(`[${g.project}] ${g.rel} —— ${g.chapters.length} 章`);
              for (const c of g.chapters) {
                const head = `  ${c.num || '·'} ${c.title}${c.module && c.module !== c.title ? ` [${c.module}]` : ''} · ${c.sections.length} 节`;
                lines.push(head);
                const secs = c.sections.map(
                  (s) => `${s.num ? `${s.num} ` : ''}${s.title}${s.anchor ? ` #${s.anchor}` : ''}`,
                );
                if (args.chapter) {
                  for (const s of c.sections) {
                    lines.push(
                      `    ${s.num ? `${s.num} ` : ''}${s.title}${s.anchor ? ` #${s.anchor}` : ''}  (L${s.line})`,
                    );
                  }
                } else if (secs.length) {
                  const preview = secs.slice(0, 3);
                  if (secs.length > 3) preview.push(`…+${secs.length - 3}`);
                  lines.push(`    ${preview.join(' | ')}`);
                }
              }
              if (g.changelog) {
                const cl = g.changelog;
                lines.push(
                  cl.volumes > 1
                    ? `  ${cl.num} ${cl.title} —— ${cl.volumes} 卷 / ${cl.entries} 条（最新卷 ${cl.latestVolume}）`
                    : `  ${cl.num} ${cl.title} —— ${cl.entries} 条（最新 ${cl.latestEntry}）`,
                );
              }
              if (g.meta?.length) lines.push(`  规范/其他: ${g.meta.join(', ')}`);
            }
            if (value.warnings?.length) {
              lines.push(`审计: ${value.warnings.length} 处结构问题 —— ${value.warnings.slice(0, 3).join('；')}`);
            }
            lines.push('用法: mode=search 关键词；mode=section section="03.2"（或 #anchor）读单节；chapter 可收窄。');
            const budgeted = budgetLines(lines, docsBudget);
            return [
              {
                type: 'text',
                text:
                  budgeted.lines.join('\n') +
                  (budgeted.truncated ? `\n… 结构过长已截断（${budgeted.omitted} 行）：传 project 或 chapter 收窄。` : ''),
              },
            ];
          }
          if (value.mode === 'section') {
            const s = value.section;
            if (!s) return [{ type: 'text', text: value.next || '未找到该小节。先 mode=map 看目录。' }];
            return [
              {
                type: 'text',
                text:
                  `${s.num ? `## ${s.num} ${s.title}` : `## ${s.title}`}\n` +
                  `${s.file}:${s.line}-${s.endLine}${s.anchor ? ` · #${s.anchor}` : ''}\n\n` +
                  (s.body || '（空节）') +
                  (value.next ? `\n\n${value.next}` : ''),
              },
            ];
          }
          if (!value.hits.length) {
            return [{ type: 'text', text: value.next || `无命中（扫描 ${value.scannedFiles} 个文件）` }];
          }
          // 命中行会永久留在会话上下文里。超预算就地停手，并明确告诉模型怎么收窄 ——
          // 这比一次灌进十几 KB、把上下文推向 compaction 便宜得多。
          const all = value.hits.map(
            (h) =>
              `${h.file}:${h.line}  [${h.chapter} › ${h.section}]${h.anchor ? ` #${h.anchor}` : ''}\n    ${h.text}`,
          );
          const { lines, truncated, omitted } = budgetLines(all, docsBudget);
          const cut = truncated || value.truncated;
          return [
            {
              type: 'text',
              text:
                lines.join('\n') +
                (cut
                  ? `\n… 结果被截断${omitted > 0 ? `（本次仍有 ${omitted} 行未回传）` : ''}：` +
                    `受 ${docsBudget} 字符预算限制。收窄查询 —— 传 project / chapter / file，或先 mode=map 再 mode=section。`
                  : ''),
            },
          ];
        },
      },
      execute(args) {
        const base = root();
        const mode = args.mode === 'map' || args.mode === 'section' ? args.mode : 'search';
        const scopes = docScopes(base, args.project);
        const scannedFiles = scopes.reduce((n, s) => n + s.idx.files.length, 0);
        if (mode === 'map') {
          const map = mapDocScopes(scopes, args.chapter);
          return Promise.resolve({
            mode,
            hits: [],
            scannedFiles: map.scannedFiles,
            truncated: false,
            chapters: map.groups,
            ...(map.warnings.length ? { warnings: map.warnings } : {}),
            ...(map.groups.length ? {} : { next: '未找到分章文档集或单篇文档：检查 workspaceRoot / project 是否正确。' }),
          });
        }
        if (mode === 'section') {
          const found = findDocSection(scopes, args);
          if (!found.match) {
            return Promise.resolve({
              mode,
              hits: [],
              scannedFiles,
              truncated: false,
              ...(found.candidates.length ? { next: `未找到该小节；候选：${found.candidates.map((c) => `${c.num} ${c.title}`).join(' / ')}` } : { next: '未找到该小节。先 mode=map 看目录，或传 chapter 收窄。' }),
            });
          }
          const { p, file, sec } = found.match;
          const rawBody = file.lines.slice(sec.line, sec.endLine).join('\n').trim();
          const cap = Math.max(600, docsBudget - 300);
          const body = rawBody.length > cap ? clampText(rawBody, cap) : rawBody;
          const alternatives = found.candidates.filter((c) => !(c.file === file.rel && c.num === sec.num));
          return Promise.resolve({
            mode,
            hits: [],
            scannedFiles,
            truncated: rawBody.length > cap,
            section: {
              project: p.key,
              file: file.rel,
              path: file.abs,
              chapter: docChapterLabel(file),
              num: sec.num,
              title: sec.title,
              anchor: sec.anchor,
              line: sec.line,
              endLine: sec.endLine,
              body,
            },
            ...(alternatives.length ? { next: `同名候选：${alternatives.map((c) => `${c.num} ${c.title}`).join(' / ')}` } : {}),
          });
        }
        const keywords = (Array.isArray(args.keywords) ? args.keywords : args.keywords ? [args.keywords] : [])
          .map((k) => String(k).toLowerCase())
          .filter(Boolean);
        if (!keywords.length) {
          return Promise.resolve({
            mode,
            hits: [],
            scannedFiles,
            truncated: false,
            next: 'search 模式需要 keywords；先用 mode=map 看章节，再用 mode=section 读单节。',
          });
        }
        const result = searchDocScopes(scopes, {
          keywords,
          chapter: args.chapter,
          file: args.file,
          maxHits: Math.max(1, Math.min(args.maxHits ?? docsMaxHits, 40)),
          docsLineChars,
        });
        return Promise.resolve({ mode, ...result });
      },
      presentCall: (args) => ({
        card: 'generic',
        title:
          args.mode === 'map'
            ? '文档结构地图'
            : args.mode === 'section'
              ? `读取小节: ${args.section || ''}`
              : `检索文档: ${(args.keywords || []).join(' / ')}`,
        kind: 'read',
      }),
    }),
  );

  // ── 3. kirara_route ────────────────────────────────────────────────────────
  guard('kirara_route', () =>
    defineTool({
      name: 'kirara_route',
      description:
        'Expand a request into a Kirara development route: involved ends, ordered steps, and any decision the human must make. ' +
        'Prefer kirara_start, which returns the same routing plus docs and build commands. Non-empty decisions ⇒ call ask_user_question before writing code.',
      parameters: {
        request: {
          type: 'string',
          required: true,
          description: 'The feature/fix request in the user\'s own words (Chinese is fine).',
        },
        mode: {
          type: 'string',
          required: true,
          enum: ['docs', 'small', 'full'],
          description: 'docs = 纯文档变更（免构建）；small = 一句话小功能，构建成功即完成；full = 需要实机验证。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', required: true },
            plan: { type: 'array', required: true, items: { type: 'string' } },
            targets: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            decisions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            requiresDeviceVerification: { type: 'boolean', required: true },
            nextStep: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const body =
            `mode=${value.mode}  实机验证=${value.requiresDeviceVerification ? '需要' : '不需要'}\n` +
            `计划:\n${value.plan.map((s) => `  - ${s}`).join('\n')}\n` +
            `目标端: ${value.targets.map((t) => t.key).join(', ') || '(未识别)'}\n` +
            (value.decisions.length
              ? `⚠️ 需要用户拍板 ${value.decisions.length} 项 —— 必须先 ask_user_question 挂起:\n` +
                value.decisions.map((d) => `  - ${d.question}`).join('\n')
              : '无需拍板，可直接开发') +
            `\n下一步: ${value.nextStep}`;
          return [{ type: 'text', text: clampText(body, textBudget) }];
        },
      },
      execute(args) {
        const text = String(args.request || '');
        const small = args.mode === 'small';
        const docsOnly = args.mode === 'docs';

        const { keys, decisions, deviceRequired, reasons, uiChange, iosFocus } = routeRequest(text, {
          small,
          docs: docsOnly,
        });
        // 显式 small 但请求本身需要看效果 → 不能默默放过，必须提醒。
        const smallButNeedsDevice = small && deviceRequired;

        const targets = keys.map((k) => {
          const p = findProject(root(), k);
          return {
            key: p.key,
            title: p.title,
            dir: p.dir,
            buildLine: buildLineFor(p),
            apk: p.apk ?? null,
            constraints: p.constraints,
            ...(p.ios ? { platforms: ['android', 'ios'], iosTargets: p.ios.targets } : {}),
          };
        });

        const plan = docsOnly
          ? [
              `解读：用 kirara_docs 检索目标文档现状（端：${keys.join(', ')}）`,
              '写作：直接编辑 .md —— 纯文档变更，不构建、不实机验证',
              '同步：kirara_docsync 判断该同步哪几篇 + 每篇改哪些章节',
              '总结：kirara_summary(mode=docs) 汇总',
            ]
          : [
              `解读：用 kirara_docs 检索相关文档，确认现状与影响面（端：${keys.join(', ')}）`,
              decisions.length ? '定路线：先 ask_user_question 挂起拍板，得到答复后再继续' : '定路线：无需拍板，直接进入开发',
              '开发：按各端约束改代码（约束见 kirara_profile）',
              `构建验证：逐端执行 kirara_build（${targets.map((t) => t.key).join(', ')}）`,
              ...(iosFocus
                ? [
                    'iOS 构建/验证：target=ios-klib 是 Windows 也能跑的门禁；target=ios-framework / ios 只能在 macOS 跑，' +
                      '其中 target=ios 一条命令出「构建 + 模拟器截图 + ✅/❌ 判定」',
                  ]
                : []),
              small && !smallButNeedsDevice
                ? '完成：mode=small —— 构建成功即结束，不做实机验证'
                : '实机验证：kirara_verify 产出分步测试清单，交用户手动执行',
              ...(uiChange
                ? [
                    iosFocus
                      ? 'UI 内环：kirara_ui(action="plan") 发现 MCP/设备 → shot → 看图改 → review；收敛后 kirara_build(target=ios) + kirara_verify(ui-design) 收尾'
                      : 'UI 内环：kirara_ui(action="plan") → shot → 看图改 → review；收敛后 kirara_build + kirara_verify(purpose=ui-design) 收尾',
                  ]
                : []),
              '文档同步：kirara_docsync 判断该同步哪几篇 docs/ 下的 md，并按清单更新',
              '总结：kirara_summary 汇总（零变更轮次可跳过）',
            ];
        if (smallButNeedsDevice) {
          plan.splice(1, 0, `⚠️ 提醒：本次请求命中「界面/交互」关键词（${reasons.join('；')}），构建通过 ≠ 效果正确，mode=small 仅代表你选择免实机验证，不代表可以跳过用户验收`);
        }

        return Promise.resolve({
          mode: args.mode,
          plan,
          targets,
          decisions,
          requiresDeviceVerification: docsOnly ? false : deviceRequired || !small,
          nextStep: decisions.some((d) => d.blocking)
            ? 'STOP：存在阻塞性决策，必须先调用 ask_user_question 挂起，禁止先写代码。'
            : docsOnly
              ? '可以开始写文档；纯文档变更不需要 kirara_build。'
              : '可以开始开发；改完调用 kirara_build 验证，再用 kirara_docsync 定文档。',
        });
      },
      presentCall: (args) => ({ card: 'generic', title: `规划路线 (${args.mode})`, kind: 'other', rawInput: args.request }),
    }),
  );

  // ── 4. kirara_build ────────────────────────────────────────────────────────
  guard('kirara_build', () =>
    defineTool({
      name: 'kirara_build',
      description:
        'Run the real per-project build for Kirara and return a verdict: ok, exit code, duration, extracted errors, and a bounded log tail. ' +
        'The only correct way to verify a build here (the API .slnx is broken; desktop needs -p:Platform=x64). Runs in the DSH host, so shell-sandbox and tool-timeout limits do not apply. ' +
        'media 是双端：target=ios 会在 macOS 上跑模拟器自检并直接产出 UI 截图（Windows 上退化为 klib 门禁并给出 Mac 命令）。',
      parameters: {
        project: {
          type: 'string',
          required: true,
          enum: ['desktop', 'api', 'media'],
          description: 'Which sub-project to build.',
        },
        target: {
          type: 'string',
          enum: ['auto', 'android', 'ios-klib', 'ios-framework', 'ios'],
          description:
            '仅 media：auto（默认，macOS→ios、Windows→android）| android | ios-klib（只编 iOS klib，Windows 也能跑，最快门禁）| ' +
            'ios-framework（只链接 framework）| ios（模拟器自检：构建+装模拟器+截图+✅/❌ 判定）。' +
            'ios-framework / ios 需要 macOS —— 在 Windows 上会退化为 klib 门禁并回传要在 Mac 上跑的命令。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: { type: 'string', required: true },
            target: { type: 'string', required: true },
            command: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            // 可选字段也不能声明 required（dsh-tools 要求 required 为 true 时该键必须在 properties 里）；
            // 这里直接省略 required 表示可选。
            exitCode: { type: 'integer' },
            timedOut: { type: 'boolean', required: true },
            durationMs: { type: 'integer', required: true },
            errors: { type: 'array', required: true, items: { type: 'string' } },
            logTail: { type: 'string', required: true },
            artifact: { type: 'string' },
            screenshots: { type: 'array', items: { type: 'string' } },
            verdicts: { type: 'array', items: { type: 'string' } },
            macCommands: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `${value.ok ? '✅ 构建成功' : value.timedOut ? '⏱️ 构建超时' : '❌ 构建失败'} — ` +
              `${value.project}${value.target && value.target !== 'android' ? `(${value.target})` : ''}  ` +
              `(${(value.durationMs / 1000).toFixed(1)}s, exit=${value.exitCode ?? 'n/a'})\n` +
              `$ ${value.command}\n` +
              (value.note ? `说明: ${value.note}\n` : '') +
              (value.artifact ? `产物: ${value.artifact}\n` : '') +
              (value.screenshots?.length ? `截图(${value.screenshots.length}):\n${value.screenshots.map((s) => `  - ${s}`).join('\n')}\n` : '') +
              (value.verdicts?.length ? `脚本判定:\n${value.verdicts.map((v) => `  ${v}`).join('\n')}\n` : '') +
              (value.macCommands?.length
                ? `需在 macOS 上执行:\n${value.macCommands.map((c) => `  $ ${c}`).join('\n')}\n`
                : '') +
              (value.errors.length ? `错误:\n${value.errors.map((e) => `  - ${e}`).join('\n')}\n` : '') +
              `日志尾部:\n${value.logTail}`,
          },
        ],
      },
      async execute(args) {
        const base = root();
        const p = findProject(base, args.project);
        const dir = projectDir(base, p);
        const requested = String(args.target || 'auto');
        // 非 media 端没有 iOS 分支：target 一律归一成 android，避免把 mac 命令塞给 desktop/api。
        const target = !p.ios
          ? 'android'
          : ['android', 'ios-klib', 'ios-framework', 'ios'].includes(requested)
            ? requested
            : IS_MAC
              ? 'ios'
              : 'android';
        if (!existsSync(dir)) {
          return {
            project: p.key,
            target,
            command: '',
            ok: false,
            timedOut: false,
            durationMs: 0,
            errors: [`子项目目录不存在: ${dir}`],
            logTail: '',
          };
        }

        const plan = p.ios ? iosPlan(p.ios, dir) : null;
        const notes = [];
        const macCommands = [];
        let step;
        let extraEnv;
        if (target === 'ios-klib') {
          step = plan.klib;
          notes.push('klib 门禁：Windows / macOS 都能跑，证明 iOS 侧的 Kotlin 代码能编过；不证明能链接、也不证明界面渲染正确。');
        } else if (target === 'ios-framework') {
          if (IS_MAC) {
            step = plan.link;
            notes.push('只链接 framework（真机 + 模拟器两个 target）；要跑界面还得 target=ios。');
          } else {
            step = plan.klib;
            macCommands.push(plan.link.macLine);
            notes.push(`本机是 ${HOST_PLATFORM} ⇒ 只跑了 klib 门禁；链接 framework 必须在 macOS 上执行（命令见 macCommands）。`);
          }
        } else if (target === 'ios') {
          if (IS_MAC) {
            step = plan.script;
            extraEnv = {
              // Xcode 的 Run Script 不读 ~/.zshrc，这条 JAVA_HOME 是 P0 清单里反复踩的坑；
              // 外部已设就尊重外部，否则用文档里那份实测可用的 JDK。
              JAVA_HOME: process.env.JAVA_HOME || expandHome(p.ios.javaHome),
              KIRARA_DEVICE: p.ios.device,
              KIRARA_OUT: plan.evidence,
              // 默认把端到端自检与 T4（WKWebView 进媒体页）都打开 ——
              // 只截一张登录页不足以证明「改动在界面上可见」。
              KIRARA_IOS_SELFTEST: process.env.KIRARA_IOS_SELFTEST ?? '1',
              KIRARA_IOS_T4: process.env.KIRARA_IOS_T4 ?? '1',
              KIRARA_IOS_T4_OVERLAY: process.env.KIRARA_IOS_T4_OVERLAY ?? '0',
            };
            notes.push(
              `一条命令 = 构建 → 装模拟器(${p.ios.device}) → 启动 → 截图 → ✅/❌ 判定；` +
                `截图可直接传给 kirara_verify(purpose=ui-design)。` +
                `但**做界面迭代时不要走这条全量自检**：kirara_ui(action="shot") 一张图只要几秒，` +
                `这条脚本留给收敛后的验收。首次全量约 4 分钟（konan 工具链 + 链接）。`,
            );
          } else {
            step = plan.klib;
            // 这些命令要在 **Mac** 上跑，而 Mac 上仓库不在本机这个路径 —— 所以不写本机绝对路径，
            // 只给一个必须被替换的占位符。写死 Windows 路径会让人拷过去后 cd 失败，比不写更糟。
            const cd = `cd <Kirara_Media 在 Mac 上的路径> && `;
            macCommands.push(
              `${cd}${plan.link.macLine}`,
              `${cd}KIRARA_IOS_SELFTEST=1 KIRARA_IOS_T4=1 ${plan.script.macLine}   # 构建+装模拟器+截图+判定`,
            );
            notes.push(
              `本机是 ${HOST_PLATFORM} ⇒ 只跑了 klib 门禁。iOS 的链接 / 出包 / 模拟器截图必须在 macOS 上执行` +
                '（命令见 macCommands；完整环境与坑点见 app/docs/Kirara Media iOS P0 Mac 执行清单.md）。',
            );
          }
        } else {
          step = IS_WIN
            ? { cmd: p.build.cmd, args: p.build.args, line: `${p.build.cmd} ${p.build.args.join(' ')}` }
            : gradleStep(p.build.args);
          if (p.ios) {
            notes.push(
              IS_MAC
                ? 'Android 主线：这台 Mac 若没装 Android SDK 会失败（P0 清单 §9.2-⑤），Android 回归建议回 Windows。'
                : 'Android 主线（:app debug）。iOS 侧见 target=ios-klib / ios-framework / ios。',
            );
          }
        }

        const r = await runProcess(step.cmd, step.args, dir, timeoutMs, extraEnv);
        const combined = `${r.stdout}\n${r.stderr}`;
        let artifact;
        if (p.apk && target === 'android') {
          const apk = join(dir, p.apk);
          if (existsSync(apk)) artifact = apk;
        }
        // 模拟器截图就是 iOS 侧的「产物」：UI 验证的输入。
        const screenshots = target === 'ios' && IS_MAC && plan ? listScreenshots(plan.evidence) : [];
        const verdicts = target === 'ios' && IS_MAC ? extractVerdicts(combined) : [];
        // 脚本自己的 ❌ 判定（构建失败 / 安装失败）必须让 ok 变红：退出码还不够 ——
        // run-simulator.sh 在「构建成功但装不上」时也可能以 0 结束。
        const verdictFailed = verdicts.some((v) => v.startsWith('❌'));
        // 构建日志会永久留在会话上下文里，所以三层设限：
        //   逐行截断（NuGet/Gradle 单行可上千字符）→ 取尾部 N 行 → 整体字符预算。
        // 实测未设限时单次 kirara_build 曾返回 16.8 KB（≈5000 token），足以把一次
        // 长会话提前推过 compaction 阈值，而 compaction 会让整段前缀缓存作废。
        //
        // ⚠️ 截断必须**自己说出来**：不带标记的尾部日志会让模型以为「这就是全部输出」，
        // 于是把真正的失败原因当成「没报错」。所以只要砍过行或砍过行内字符，就在开头加一行说明
        // （放开头是因为 clampText 从尾部砍，标记在开头一定留得住）。
        const allLines = combined.trim() ? combined.trim().split(/\r?\n/) : [];
        const keptLines = allLines.length > logTail ? allLines.slice(-Math.max(1, logTail)) : allLines;
        const droppedLines = allLines.length - keptLines.length;
        const droppedChars = keptLines.reduce((sum, line) => sum + Math.max(0, line.length - buildLineChars), 0);
        const truncationNote =
          droppedLines > 0 || droppedChars > 0
            ? `… [日志已截断：共 ${allLines.length} 行，只回传最后 ${keptLines.length} 行；` +
              `${droppedChars > 0 ? `单行超 ${buildLineChars} 字符的部分共省略 ${droppedChars} 字符；` : ''}` +
              '完整输出见构建窗口 / kirara_build 的 command]'
            : '';
        const clampedTail = keptLines.map((line) => clampLine(line, buildLineChars)).join('\n');
        // ⚠️ 可选键必须「整键省略」，不能赋成 undefined。
        // 宿主会对返回值做 lossless JSON 快照（@deepseek-ai/dsh-util-values 的
        // walkJsonValue 逐键 visit，值为 undefined 的自有可枚举键直接判负），
        // 一旦出现 undefined，整次调用就变成
        // `tool "kirara_build" returned invalid output: value is not lossless JSON` ——
        // 三端里 api/desktop 没有 apk 字段 ⇒ artifact 恒为 undefined ⇒ 这两端的构建验证
        // 从来就没成功返回过（2026-10-05 实测复现）。也不能用 `?? null` 兜：schema 把
        // exitCode 声明成 integer，null 会被 "must be an integer" 拒掉。
        return {
          project: p.key,
          target,
          command: step.line,
          ok: r.ok && !verdictFailed,
          ...(r.code == null ? {} : { exitCode: r.code }),
          timedOut: r.timedOut,
          durationMs: r.durationMs,
          errors: extractErrors(combined).map((e) => clampLine(e, buildLineChars)),
          logTail: clampText(truncationNote ? `${truncationNote}\n${clampedTail}` : clampedTail, buildBudget),
          ...(artifact === undefined ? {} : { artifact }),
          ...(screenshots.length ? { screenshots } : {}),
          ...(verdicts.length ? { verdicts } : {}),
          ...(macCommands.length ? { macCommands } : {}),
          ...(notes.length ? { note: notes.join(' ') } : {}),
        };
      },
      presentCall: (args) => ({ card: 'generic', title: `构建 ${args.project}${args.target && args.target !== 'auto' ? ` (${args.target})` : ''}`, kind: 'execute' }),
    }),
  );

  // ── 5. kirara_verify ───────────────────────────────────────────────────────
  guard('kirara_verify', () =>
    defineTool({
      name: 'kirara_verify',
      description:
        'Produce a step-by-step real-device acceptance checklist (action + expected result) for the human to run. ' +
        'No unit tests here: verification = build + this checklist; mode=small/docs skips it. ' +
        'UI work is mandatory: pass screenshots with purpose=ui-design to get an actionable P0/P1 redesign protocol instead of a pass/fail check.',
      parameters: {
        summary: {
          type: 'string',
          required: true,
          description: 'What changed, so the checklist can target it.',
        },
        project: {
          type: 'string',
          required: true,
          enum: ['desktop', 'api', 'media'],
        },
        mode: {
          type: 'string',
          required: true,
          enum: ['docs', 'small', 'full'],
          description: 'docs = 纯文档变更（跳过）；small = 免实机验证（只构建）；full = 需要实机验证清单。',
        },
        purpose: {
          type: 'string',
          enum: ['acceptance', 'ui-design'],
          description:
            'acceptance (default) = 通过/不通过式验收；ui-design = UI 设计复核：产出 P0/P1/P2 可落地修改建议 + 改完重截复核。' +
            'UI/样式改动一律用 ui-design。',
        },
        screenshots: {
          type: 'array',
          description:
            'Absolute screenshot paths. Required for UI work: without them the result flags needScreenshots. ' +
            `Feeds ${VISION_PROVIDER}/${VISION_MODEL} (input: text+image).`,
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            skipped: { type: 'boolean', required: true },
            reason: { type: 'string' },
            steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            howToInstall: { type: 'string' },
            needScreenshots: { type: 'string' },
            screenshotReview: { type: 'object', additionalProperties: true },
          },
        },
        render: (renderArgs, value) => {
          const body = value.skipped
            ? `跳过实机验证（mode=${renderArgs.mode}）。${value.reason || ''}`
            : `实机验证清单（共 ${value.steps.length} 步）:\n` +
              (value.howToInstall ? `${value.howToInstall}\n` : '') +
              value.steps
                .map((s, i) => `${i + 1}. ${s.action}\n   期望: ${s.expected}`)
                .join('\n') +
              (value.needScreenshots ? `\n\n⚠️ 截图缺失（UI 改动必经）: ${value.needScreenshots}\n` : '') +
              (value.screenshotReview
                ? `\n\n📷 截图复核协议 [${value.screenshotReview.purpose}]（${value.screenshotReview.provider}/${value.screenshotReview.model}）:\n` +
                  `   待复核 ${value.screenshotReview.screenshots.length} 张：\n` +
                  value.screenshotReview.screenshots
                    .map((s) => `     - ${s.path}${s.exists ? '' : '  ⚠️ 文件不存在'}`)
                    .join('\n') +
                  `\n   下一步：${value.screenshotReview.instruction}`
                : '');
          return [{ type: 'text', text: clampText(body, textBudget) }];
        },
      },
      execute(args) {
        if (args.mode === 'docs') {
          return Promise.resolve({
            skipped: true,
            reason:
              '纯文档变更（mode=docs）：没有代码变更 ⇒ 不构建、也不产出实机清单。' +
              '如果需要的是文档同步，见 kirara_docsync。',
            steps: [],
          });
        }
        if (args.mode === 'small') {
          return Promise.resolve({
            skipped: true,
            reason: '小功能按约定免实机验证，仅需构建成功。如需真机确认，用 mode=full 重新调用。',
            steps: [],
          });
        }
        const p = findProject(root(), args.project);
        const purpose = args.purpose === 'ui-design' ? 'ui-design' : 'acceptance';
        const summary = String(args.summary || '');
        // media 是双端：iOS 侧「怎么看界面」与 Android 完全不同（模拟器 + 截图 vs 真机 adb），
        // 给错清单等于让人拿 adb 去验一个 WKWebView。
        // 判定：summary 命中 iOS 词族；或本机是 macOS 且没在说 Android（Mac 上没装 Android SDK，
        // 默认按 iOS 走才对；但用户明确说「安卓」时不能把他带偏）。
        const saysAndroid = /\bandroid|安卓|apk|adb\b/i.test(summary);
        const iosFocus = Boolean(p.ios) && (IOS_SIGNALS.test(summary) || (IS_MAC && !saysAndroid));
        // 是否需要「看图」：显式声明，或改动描述里出现界面/交互词族。
        // 后者是兜底 —— 模型忘了传 purpose 时，UI 改动仍然会被截图环节拦一次。
        const uiWork =
          purpose === 'ui-design' || UI_HINTS.test(summary) || INTERACTION_SIGNALS.test(summary);
        const base = [
          { action: '构建产物就绪，确认无错误输出', expected: 'kirara_build 返回 ok=true' },
        ];
        // UI 改动：截图 → 视觉复核 → 按建议改 → 重截。这一步不看截图就是盲改样式。
        if (uiWork) {
          // media 的界面看看有没有走过实时视觉环（kirara_ui）。状态文件是**事实**，
          // 而「我看了」是自述 —— 所以这里按状态说话，只在没闭环时提醒，不拦调用。
          if (p.key === 'media') {
            const loop = readUiLoopSummary(root(), p, config.uiLoopDir);
            if (!loop.closed) {
              base.push({
                action:
                  '（视觉环未闭环）先 kirara_ui(action="status") 看差什么：闭环 = ≥1 张截图 + ≥1 轮 review + 无未修 P0/P1',
                expected: `closed=true（当前 ${loop.shots} 张 / ${loop.iterations} 轮 / 未修 ${loop.openIssues.length} 条）`,
              });
            }
          }
          base.push({
            action: iosFocus
              ? '（UI 必经）截图走 kirara_ui(action="shot")；Xcode MCP 回传的 PNG 用 action="shot", paths=[...] 采纳进编号证据，再把路径传给本工具'
              : '（UI 必经）截取本次改动涉及的界面：同一窗口尺寸/主题下各状态一张，' +
                '存成 png 后把绝对路径传给 kirara_verify({ purpose: "ui-design", screenshots: [...] })',
            expected: iosFocus
              ? '每张截图（01-login / 02-logged-in / 03-wkwebview）都能看清改动区域；看不到的界面明确写「没截图」'
              : '每张截图都能看清改动区域；看不到的界面明确写「没截图」，不要用「应该没问题」代替',
          });
        }
        const perProject = {
          desktop: [
            { action: '以 Unpackaged 方式启动 Kirara_Server Core（推荐调试路径）', expected: '主窗口正常出现，无「启动失败」弹窗' },
            { action: '观察启动阶段：字体自查弹窗（仅首次）/ 登录页渲染', expected: '首次启动出现图标自查墙；否则直接进入登录页且无空窗闪帧' },
            { action: '登录 → 确认首页三容器（登录面板/快速开始/通知中心）入场动画', expected: '按序淡入 + 微上浮，通知中心带缩放弹出；遮罩「正在初始化中...」后首帧即有内容' },
            { action: '打开与该改动相关的方案页，触发一次真实交互', expected: { placeholder: '按本次改动补写具体期望' } },
            { action: '切换明暗主题与主题色各一次', expected: '改动涉及的控件即时跟随，无需刷新页面' },
            { action: '（若涉及 WebView2/RDP）打开方案后关闭实例', expected: '无 msedgewebview2 / sdl-freerdp 残留进程' },
          ],
          api: [
            { action: '启动 AppHost：dotnet run --project Kirara_Server-API.AppHost', expected: 'Aspire Dashboard 起来，Server 资源为 Healthy' },
            { action: '访问 /api/health 与 /health', expected: '返回健康状态，统一 ApiResponse 格式 { success, data, timestamp }' },
            { action: { placeholder: '按本次改动调用对应端点（含认证头）' }, expected: '返回结构与文档一致；未认证时返回 401' },
            { action: '（若改了表结构）确认升级脚本已执行', expected: 'docs/sql/init.sql 或 upgrade_vN_*.sql 已应用，EF 模型与库一致' },
          ],
          media: iosFocus
            ? [
                {
                  action: `在 macOS 上跑 kirara_build({ project: 'media', target: 'ios' })（= bash ${p.ios.script}，设备 ${p.ios.device}）`,
                  expected: '构建 PASS + 模拟器装上并启动；截图写进 iosApp/.tmp/ios-evidence/',
                },
                {
                  action: '看脚本判定：`✅ 自检 PASS`（渲染 → Koin → 登录回调）与 `✅ T4 PASS`（WKWebView 跑到 SPA 就绪）',
                  expected: '两条 ✅ 都要在；只有 `⚠️ 未见 SPA 就绪` = 网络/凭据/拦截页问题，别当「大概没事」',
                },
                {
                  action: '登录 → 自动进媒体页 → WKWebView 加载真实站点',
                  expected: '落在媒体页而非登录页；是 Jellyfin 的 SPA，不是 nginx 拦截页或白屏',
                },
                {
                  action: '只有 simctl 做不到的事才开 DeviceHub 人肉复核',
                  expected: `键盘/IME/手动点「手动登录」：open ${p.ios.simGui}`,
                },
                {
                  action: '过一遍 iOS 静默坑（编译期抓不到）',
                  expected:
                    'Swift 里是 doInitKoinIos()；Run Script 要 export JAVA_HOME；路由钩子 documentStart 且只认最后一个事件；' +
                    'setCookie 等回调再 load（完整清单见 P0 清单 §7/§10.3/§11.3）',
                },
                { action: '打开与该改动相关的界面并操作', expected: { placeholder: '按本次改动补写具体期望' } },
              ]
            : [
                { action: '把 app-debug.apk 装到真机（或 adb install -r）', expected: '安装成功；覆盖升级时本地数据保留' },
                { action: '冷启动 App，观察启动背景与进入动画', expected: '手机端专属背景优先，404 时回退通用背景；无白屏' },
                { action: '登录通行证 → 链接令牌 → 进入媒体页', expected: '自动登录成功，落在媒体页而非登录页' },
                { action: '打开与该改动相关的界面并操作', expected: { placeholder: '按本次改动补写具体期望' } },
                { action: '切到后台再切回，旋转屏幕（若涉及视频）', expected: '媒体页不重载；播放保留进度不退回首页' },
              ],
        };
        const steps = [...base, ...(perProject[p.key] || [])].map((s) => ({
          action: typeof s.action === 'string' ? s.action : `按本次改动补写：${args.summary}`,
          expected: typeof s.expected === 'string' ? s.expected : '按本次改动补写具体期望',
        }));
        // UI 改动的收尾是**循环**而不是一次判定：改完要重截、重看，直到没有 P0/P1。
        if (uiWork) {
          steps.push({
            action: '按复核建议改完 UI 后，在同一状态下重新截图并再跑一次本工具（purpose=ui-design）',
            expected: '复核对齐：上一轮的 P0/P1 全部消失；没有「改了但没人看过」的样式改动',
          });
        }
        const howToInstall =
          p.key === 'media'
            ? iosFocus
              ? `运行：bash ${p.ios.script}（KIRARA_IOS_SELFTEST=1 KIRARA_IOS_T4=1）→ 截图在 ${p.ios.evidenceDir}/；` +
                '日志：`xcrun simctl get_app_container booted <bundleId> data` 下的 Documents/kirara.log。Windows 侧只能跑 klib 门禁。'
              : `安装：产物在 ${p.apk}（相对 ${p.dir}），用 adb install -r 或直接拷到手机安装。`
            : p.key === 'desktop'
              ? `运行：${p.dir} 下 Debug 构建产物（Unpackaged）。注意 app.manifest 要求管理员权限。`
              : `运行：cd ${p.dir} && ${p.run.cmd} ${p.run.args.join(' ')}`;

        // 截图复核：只产出协议，不自己调模型。
        // 插件跑在宿主进程里，拿不到会话级 llm 服务；由模型按协议发起真正的图像推理。
        //
        // 两种 purpose 问的是不同的问题，不能混：
        //   acceptance —— 「这版能不能发」：通过 / 不通过 + 依据，逐条判定。
        //   ui-design  —— 「这版该怎么改」：需要可落地的修改项（控件 + 数值 + 优先级），
        //                 因为接下来的动作是**改代码**，只给「不好看」等于没给。
        const shots = args.screenshots || [];
        const visionNote =
          `\n   注意：${VISION_MODEL} 是当前唯一吃图的模型（ecnu-max 只吃文本）；` +
          '截图 exists=false 时先确认路径，别凭文件名猜内容。';
        const visionHead =
          `用 llm 服务以 provider=${VISION_PROVIDER} / model=${VISION_MODEL} 发起一次多模态请求：` +
          '把上面每张截图作为 ImageBlock（attachment）连同下面的提示一起发送 —— 「';
        const shotKind = iosFocus ? ' iOS 模拟器（iPhone）' : ' 实机';
        const uiDesignPrompt =
          `这是 Kirara 在${shotKind}上的界面截图，本轮改动：${args.summary}。` +
          '请按「接下来要改什么代码」来评审，不要只给审美评价。逐条给出：' +
          '① 视觉层级与对齐：哪些元素的间距/字号/圆角/对齐与同屏其他元素不一致 —— 指名控件并给建议数值；' +
          '② 与改动目标的一致性：本次改动在截图里是否真的可见，是否挤压或破坏了原本正常的区域；' +
          '③ 明显缺陷：截断/溢出/对比度不足/缺失图标/缺空态与加载态/深色主题下不可读；' +
          '④ 每条按 P0/P1/P2 标注，写成「改哪个文件或控件 → 改成什么」；最后给可直接执行的修改清单。看不到就说看不到，不要臆测。」';
        const acceptancePrompt =
          `这是 Kirara 改动的截图（${shotKind.trim()}），改动内容：${args.summary}。` +
          '请逐张判断：① 界面是否正常渲染（无白屏/错位/乱码/占位图）；' +
          '② 是否可见本次改动对应的 UI；③ 有无明显异常（错误弹窗、缺失图标、对比度问题）。' +
          '逐条给出「通过 / 不通过 + 依据」，最后给一句总体结论。不要臆测看不到的内容。」';
        const uiDesignTail =
          '\n   → 拿到清单后：先改 P0/P1，再按同一状态重新截图，重跑本工具复核，直到没有 P0/P1 为止。';
        const acceptanceTail = '\n   → 只要有一条「不通过」，修完必须重截复核，不要在没看图的情况下宣称完成。';

        let screenshotReview;
        if (shots.length) {
          screenshotReview = {
            provider: VISION_PROVIDER,
            model: VISION_MODEL,
            purpose,
            task: args.summary,
            screenshots: shots.map((s) => {
              const abs = resolve(String(s));
              return { path: abs, exists: existsSync(abs) };
            }),
            instruction:
              visionHead +
              (purpose === 'ui-design' ? uiDesignPrompt : acceptancePrompt) +
              (purpose === 'ui-design' ? uiDesignTail : acceptanceTail) +
              visionNote,
          };
        }
        // UI 改动没给截图：不静默放过，明确要求先去要图。
        // 这是「UI 开发必经截图」的机器化落实 —— 不依赖模型记不记得。
        let needScreenshots;
        if (uiWork && shots.length === 0) {
          needScreenshots = iosFocus
            ? `本轮是 iOS 侧 UI/界面改动，但没有传 screenshots。正确流程（**不要**改成向用户要图）：` +
              `① kirara_ui({ action: 'shot', platform: 'ios' }) 截一张（没装设备控制 MCP 也能用，走 simctl 兜底）；` +
              `若是 Xcode MCP 的 DeviceInteractionSynthesize 回传的 PNG，用 kirara_ui({ action: 'shot', paths: [...] }) 采纳进编号证据；` +
              `② 用 read_image 真正看图；③ 把路径传给 ` +
              `kirara_verify({ summary, project: 'media', mode: 'full', purpose: 'ui-design', screenshots: [...] }) 复核。` +
              '在拿到并真正看过截图之前，不要宣称样式「已经对齐/和设计一致」；' +
              '在 Windows 上这一步无法本地完成，必须交接给 Mac，不能拿「构建通过」代替看图。'
            : `本轮是 UI/界面改动（summary 命中界面或交互词族，或 purpose=ui-design），但没有传 screenshots。` +
              `正确流程：${p.key === 'media' ? "kirara_ui({ action: 'shot' }) 抓一张（或 action: 'shot', paths:[...] 采纳已有截图），用 read_image 看过之后，" : '先请用户提供实机截图（绝对路径），'}` +
              `再用 kirara_verify({ summary, project: '${p.key}', mode: 'full', purpose: 'ui-design', screenshots: [...] }) 复核；` +
              '在拿到截图之前，不要宣称样式「已经对齐/和设计一致」。';
        }
        // ⚠️ 无截图时**不能**写成 `screenshotReview`（即 undefined）：宿主对返回值做 lossless
        //    快照校验，显式的 undefined 会让整次调用以
        //    `tool "kirara_verify" returned invalid output` 被拒收 —— 与 §4.2 artifact 同源。
        //    条件展开确保该键在无截图时**根本不出现**。
        return Promise.resolve({
          skipped: false,
          steps,
          howToInstall,
          ...(needScreenshots === undefined ? {} : { needScreenshots }),
          ...(screenshotReview ? { screenshotReview } : {}),
        });
      },
      presentCall: (args) => ({ card: 'generic', title: `生成实机测试清单 (${args.project})`, kind: 'other' }),
    }),
  );

  // ── 6. kirara_summary ──────────────────────────────────────────────────────
  guard('kirara_summary', () =>
    defineTool({
      name: 'kirara_summary',
      description:
        'Render the closing summary of one Kirara round: changes, build verdicts, verification status, docs synced, remaining risks. ' +
        'Call it once at the end of a round that actually changed code; skip rounds with no changes.',
      parameters: {
        feature: { type: 'string', required: true, description: 'What was developed.' },
        mode: { type: 'string', required: true, enum: ['docs', 'small', 'full'] },
        changes: {
          type: 'array',
          required: true,
          description: 'Changed files or areas.',
          items: { type: 'string' },
        },
        docs: {
          type: 'array',
          description: 'Docs updated in this round (paths from kirara_docsync).',
          items: { type: 'string' },
        },
        builds: {
          type: 'array',
          description: 'Build verdicts, e.g. ["api: ok 6.4s", "desktop: ok 41s"].',
          items: { type: 'string' },
        },
        risks: {
          type: 'array',
          description: 'Remaining risks / follow-ups.',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            markdown: { type: 'string', required: true },
            deviceVerificationRequired: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: clampText(value.markdown, textBudget) }],
      },
      execute(args) {
        const full = args.mode === 'full';
        const docsOnly = args.mode === 'docs';
        const modeNote = docsOnly
          ? '纯文档变更，不构建、不实机验证'
          : full
            ? '含实机验证'
            : '小功能，仅构建验证';
        // 界面改动必须留下「看过的证据」：kirara_ui 的环状态是**事实**，模型的自述不是。
        // 只在本轮确有界面嫌疑时才算这一条，避免给 api 端 / 纯后端轮次制造噪音。
        const uiTouched =
          !docsOnly &&
          (UI_HINTS.test(String(args.feature || '')) ||
            UI_HINTS.test((Array.isArray(args.changes) ? args.changes : []).join(' ')));
        const loopRisk = [];
        if (uiTouched) {
          const loop = readUiLoopSummary(root(), findProject(root(), 'media'), config.uiLoopDir);
          if (loop.shots === 0) {
            loopRisk.push('本轮没有任何视觉环证据（kirara_ui）：若确实改到界面，先 shot + review 看过再写总结');
          } else if (!loop.closed) {
            loopRisk.push(
              `视觉环未闭环：截图 ${loop.shots} 张 / 迭代 ${loop.iterations} 轮 / 未修 ${loop.openIssues.length} 条` +
                ' —— 未修项清空之前不要写「已完成」',
            );
          }
        }
        const lines = [
          `## 开发总结：${args.feature}`,
          '',
          `- 模式：\`${args.mode}\`（${modeNote}）`,
          '',
          '### 变更',
          ...(args.changes?.length ? args.changes.map((c) => `- ${c}`) : ['- （未记录）']),          '',
          '### 构建验证',
          docsOnly
            ? '- 不适用：纯文档变更（.md 不参与编译，跑构建没有意义）'
            : args.builds?.length
              ? args.builds.map((b) => `- ${b}`)
              : ['- （未记录）'],
          '',
          '### 实机验证',
          docsOnly
            ? '- 不适用：纯文档变更'
            : full
              ? '- 已产出分步测试清单，待你手动执行（见 kirara_verify 输出）'
              : '- 按约定跳过：小功能构建成功即完成',
          '',
          '### 文档同步',
          args.docs?.length
            ? args.docs.map((d) => `- ${d}`)
            : docsOnly
              ? '- （本轮就是文档改动，建议把改过的 md 一并记到这里）'
              : '- ⚠️ 未记录：新功能 / BUG 修复请先用 kirara_docsync 判断该同步哪几篇 docs/',
          '',
          '### 遗留风险 / 后续',
          ...(args.risks?.length ? args.risks.map((r) => `- ${r}`) : loopRisk.length ? [] : ['- 无']),
          ...loopRisk.map((r) => `- ⚠️ ${r}`),
          // 进程清理红线不再逐轮重放：它已经在 kirara_profile 的输出里，每次总结再贴一遍
          // 只是往上下文里重复灌同样的两行。
        ];
        return Promise.resolve({
          markdown: lines.join('\n'),
          deviceVerificationRequired: full,
        });
      },
      presentCall: (args) => ({ card: 'generic', title: `总结：${args.feature}`, kind: 'other' }),
    }),
  );

  // ── 7. kirara_docsync ──────────────────────────────────────────────────────
  // 流程里的「收尾前半步」：代码改了 → 测试过了 → 判断该同步哪几篇文档。
  // 为什么不是可选项：README / docs 下的 md 是**下一个会话的作业依据**，
  // 文档与代码的偏差是静默的 —— 没人报错，但后来者会照着过期事实写代码。
  guard('kirara_docsync', () =>
    defineTool({
      name: 'kirara_docsync',
      description:
        'Decide which docs a change must update, and exactly what to change in each: chaptered docs give target chapter + section, insertion point, anchor and frontmatter updates; single-file docs give headings. ' +
        'Also returns the writing contract (NN chapters, NN.M sections, explicit anchors, 99 changelog) and a checklist. ' +
        'Run it for every feature / bug fix before closing the round — docs drift silently and the next session then reads stale facts. Markdown-only work needs no build.',
      parameters: {
        feature: {
          type: 'string',
          required: true,
          description: 'What changed, in one line (Chinese is fine).',
        },
        changes: {
          type: 'array',
          description: 'Changed files or areas; repo-relative paths let the tool map sources via frontmatter.files and infer the involved ends.',
          items: { type: 'string' },
        },
        kind: {
          type: 'string',
          enum: ['auto', 'feature', 'fix', 'ui', 'docs', 'chore'],
          description:
            'auto (default) judges from feature + changes: fix / docs / chore / ui / feature. ' +
            'chore = 纯内部整理（无对外行为变化）⇒ 不要求改正文，只留更新记录。',
        },
        project: {
          type: 'string',
          enum: ['desktop', 'api', 'media'],
          description: 'Optional: restrict to one end.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            required: { type: 'boolean', required: true },
            kind: { type: 'string', required: true },
            reason: { type: 'string', required: true },
            targets: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            checklist: { type: 'array', required: true, items: { type: 'string' } },
            missing: { type: 'array', required: true, items: { type: 'string' } },
            writingRules: { type: 'array', items: { type: 'string' } },
            nextAction: { type: 'string', required: true },
          },
        },
        render: (_args, v) => {
          const targetLines = v.targets.map((t) => {
            if (t.role === 'changelog') {
              return `  - ${t.rel}\n      ${t.edit.action}\n      为什么: ${t.why}`;
            }
            const edit = t.edit || {};
            const action =
              edit.mode === 'new'
                ? edit.action
                : edit.mode === 'existing'
                  ? `改「${edit.section}」`
                  : edit.mode === 'chapter'
                    ? edit.action
                    : (t.sections || []).join(' / ');
            return (
              `  - ${t.rel}${t.chapter ? `  [${t.chapter} ${t.chapterTitle}]` : ''}\n` +
              `      ${action}` +
              (t.addFiles?.length ? `\n      frontmatter.files 补: ${t.addFiles.join(', ')}` : '') +
              `\n      为什么: ${t.why}`
            );
          });
          const body =
            `📄 文档同步 [${v.kind}] —— ` +
            (v.targets.length ? `需更新 ${v.targets.length} 篇\n` : '无需更新正文\n') +
            `判定: ${v.reason}\n` +
            (v.targets.length ? `目标:\n${targetLines.join('\n')}\n` : '') +
            '清单:\n' +
            v.checklist.map((c) => `  - ${c}`).join('\n') +
            (v.writingRules?.length ? `\n写法:\n${v.writingRules.map((r) => `  - ${r}`).join('\n')}` : '') +
            (v.missing.length ? `\n注意: 规则指向但**不存在**的文档 — ${v.missing.join(', ')}` : '') +
            `\n下一步: ${v.nextAction}`;
          return [{ type: 'text', text: clampText(body, docsyncBudget) }];
        },
      },
      execute(args) {
        const feature = String(args.feature || '').trim();
        const changes = (args.changes || []).map((c) => String(c)).filter(Boolean);
        // 只在调用方给了**已知**的 kind 时才采信，否则一律自己判：`KIND_LABEL[kind]` 一旦取到
        // undefined，reason 文本里就会直接出现 "undefined"（schema 的 enum 只在真调度链路里生效，
        // 夹具/直调不受它约束 —— 这类"只在某条路径上才出现"的兜底正是本仓库反复踩的坑）。
        const requestedKind = args.kind === undefined || args.kind === 'auto' ? '' : String(args.kind);
        const kind = KIND_LABEL[requestedKind] ? requestedKind : judgeChangeKind(feature, changes);

        // 涉及端：显式指定 > 变更路径里的仓库目录 > 关键词路由。
        const keys = new Set();
        if (args.project) keys.add(args.project);
        for (const c of changes) {
          const norm = c.replace(/\\/g, '/').toLowerCase();
          for (const p of PROJECTS) {
            const dir = p.dir.toLowerCase();
            if (norm.startsWith(`${dir}/`) || norm.includes(`/${dir}/`)) keys.add(p.key);
          }
        }
        if (keys.size === 0) {
          for (const k of routeRequest(feature, { docs: kind === 'docs' }).keys) keys.add(k);
        }

        const base = root();
        const required = kind !== 'chore';
        const { picked, missing, tokens } = required
          ? pickDocTargets(base, [...keys], feature, changes, docsyncMaxTargets)
          : { picked: [], missing: [], tokens: [] };

        // 目标 → 写作计划：分章集给「改哪节 / 在第几行新增 NN.M / 变更记录插哪」，
        // 单篇文档仍给标题级建议。返回值会永久留在上下文里，所以只读被选中的那几篇。
        const targets = picked.map((t) => {
          const p = findProject(base, t.project);
          const rel = `${p.dir}/${t.rel}`;
          if ((t.kind === 'chapter' || t.kind === 'changelog') && t.file) {
            const file = t.file;
            if (file.isChangelog) {
              if (t.changelogStyle === 'volume') {
                const entry = `## ${t.changelogNext} · ${feature.slice(0, 60)}`;
                const line = file.lineCount;
                return {
                  project: t.project,
                  dir: p.dir,
                  rel,
                  path: t.abs,
                  role: 'changelog',
                  sections: ['变更记录（分卷）'],
                  edit: {
                    mode: 'append',
                    line,
                    entry,
                    action:
                      `在最新卷末尾（第 ${line} 行后）追加「${entry}」+ 按该卷体例补小节` +
                      (t.changelogIndexRel ? `；并在 ${t.changelogIndexRel} 的分卷表/章号映射补一行` : ''),
                  },
                  why: t.why,
                };
              }
              const first = file.sections[0];
              const line = first ? Math.max(1, first.line - 1) : 2;
              const entry = `## ${localDateStamp()} · ${feature.slice(0, 60)}`;
              return {
                project: t.project,
                dir: p.dir,
                rel,
                path: t.abs,
                role: 'changelog',
                sections: ['变更记录（日期倒序）'],
                edit: {
                  mode: 'prepend',
                  line,
                  entry,
                  action: `在引言之后、最新条目之前（第 ${line} 行后）插入「${entry}」+ 一条变更点`,
                },
                why: t.why,
              };
            }
            const changedRel = changes
              .filter((c) => changeBelongsToProject(c, p))
              .map((c) => projectRelativeChange(c, p))
              .filter(Boolean);
            const plan = planChapterEdit(file, tokens, changedRel, feature, kind);
            return {
              project: t.project,
              dir: p.dir,
              rel,
              path: t.abs,
              role: file.isAppendix ? 'appendix' : 'module',
              chapter: file.num,
              chapterTitle: file.chapterTitle,
              sections: plan.mode === 'existing' ? [plan.section] : [],
              edit: plan,
              addFiles: missingFrontmatterFiles(file, changedRel),
              why: t.why,
            };
          }
          const sections = pickSections(t.abs, tokens);
          return {
            project: t.project,
            dir: p.dir,
            rel,
            path: t.abs,
            sections: sections.length ? sections : ['（标题未命中关键词：先看目录再定位）'],
            why: t.why,
          };
        });

        const hasChapterTargets = targets.some((t) => t.chapter || t.role === 'changelog');
        const writingRules = hasChapterTargets
          ? [
              '章节文件 `NN-标题.md`：新增模块取下一个空号；H1 用 `# NN 标题`；frontmatter 写 module / level / files / related。',
              '小节 `## NN.M 标题`，编号在本章内连续；标题前一行加 `<a id="slug"></a>`；跨文档链接只认显式锚点：`./NN-标题.md#anchor`。',
              '新增小节骨架：`### 职责与边界` / `### 关键文件` / `### 主流程` / `### 设计决策` / `### 陷阱与约定` / `### 自测点`（按需取舍）。',
              '正文只写稳定结论；本轮改了什么只进 99 变更记录（日期倒序、最新在上），正文不写「本轮」。',
              'frontmatter.files 补本次源文件，related 补关联章节；新增 DI 注册 / 内置方案 / 清单项时同步 14 附录。',
            ]
          : undefined;

        const checklist = required
          ? [
              ...targets.map((t) => {
                if (t.role === 'changelog') return `${t.rel} → ${t.edit.action}`;
                if (t.edit?.mode === 'new') {
                  return `${t.rel} → 新增「## ${t.edit.num} ${t.edit.title}」，标题前一行加 <a id="${t.edit.anchor}"></a>（第 ${t.edit.line} 行后）`;
                }
                if (t.edit?.mode === 'existing') return `${t.rel} → 改「${t.edit.section}」`;
                if (t.edit?.mode === 'chapter') return `${t.rel} → ${t.edit.action}`;
                return `${t.rel} → 改「${(t.sections || []).join(' / ')}」`;
              }),
              '逐篇核对文档里的命令 / 路径 / 版本号 / 端口 / 端点是否仍与代码一致',
              hasChapterTargets
                ? 'frontmatter.files 补本次源文件；related 补关联章；新模块取下一个空号 NN'
                : '有「## 更新记录」的文档补一条本轮条目（日期 + 变更点）',
              hasChapterTargets
                ? '改完用 kirara_docs mode=map 复查编号 / 锚点 / 断链'
                : '改完用 kirara_docs 按关键词复查，确认新行为已写进文档',
            ]
          : ['若该文档有「## 更新记录」章节，补一条内部整理说明即可；正文不需要改'];

        return Promise.resolve({
          required,
          kind,
          reason: required
            ? `${KIND_LABEL[kind]}；判定：feature「${feature.slice(0, 40)}」${changes.length ? ` + ${changes.length} 个变更路径` : ''}`
            : `${KIND_LABEL.chore}；未命中新功能 / 修复 / 界面信号 ⇒ 不要求改正文。`,
          targets,
          checklist,
          missing: missing.slice(0, 3),
          ...(writingRules ? { writingRules } : {}),
          nextAction: targets.length
            ? (targets.some((t) => t.edit)
                ? '按 targets 的 edit.action 逐篇编辑（新增小节先加 anchor）；纯文档改动不需要 kirara_build，改完在 kirara_summary 的 docs 里记一笔。'
                : '按 targets 的章节/段落建议逐篇编辑；纯文档改动不需要 kirara_build，改完在 kirara_summary 的 docs 里记一笔。')
            : '本轮无需更新正文文档；按清单收尾即可。',
        });
      },
      presentCall: (args) => ({ card: 'generic', title: `文档同步: ${args.feature}`, kind: 'read' }),
    }),
  );


  // ── 8. kirara_release_notes ────────────────────────────────────────────────
  // 发布流程的第 0 步：把「上个版本 → 本次」的提交摊开，挑出**新增功能**。
  //
  // 存在的理由就是用户那条硬要求：README 里只能出现新功能，不能出现 BUG 与修复。
  // 但分类必然是启发式的 —— 所以这个工具回的是**分桶素材 + 写作规则**，
  // 最终「哪几条算用户能感知的功能」由模型判断，工具不替模型写 README。
  guard('kirara_release_notes', () =>
    defineTool({
      name: 'kirara_release_notes',
      description:
        'Collect the git range since the last version tag and split it into features / fixes / internal / unclear, so the README can be updated with user-facing features only. ' +
        'Run it BEFORE kirara_release: the release tool refuses to package while the README still carries the previous version. ' +
        'Bug fixes are listed separately and must never be written into the README.',
      parameters: {
        project: {
          type: 'string',
          required: true,
          enum: ['desktop', 'api', 'media'],
          description: 'Which sub-project is being released.',
        },
        version: {
          type: 'string',
          description: "The version being released (e.g. 1.6.6). Defaults to the project's current version bumped by its own rule.",
        },
        from: {
          type: 'string',
          description: 'Base ref of the range (tag or sha). Defaults to the highest version tag that is an ancestor of HEAD.',
        },
        bump: {
          type: 'string',
          enum: ['none', 'patch', 'minor', 'major'],
          description: "How to derive the target version when version is omitted. Defaults to the project's own rule (api: patch, others: none).",
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: { type: 'string', required: true },
            version: { type: 'string', required: true },
            previousVersion: { type: 'string', required: true },
            from: { type: 'string', required: true },
            fromKind: { type: 'string', required: true },
            to: { type: 'string', required: true },
            commitCount: { type: 'integer', required: true },
            features: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            fixes: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            internal: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            ambiguous: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            // 各桶的**真实**条数：列表可能被截断/限量，但量级必须始终可见 ——
            // 否则人没法判断「这一桶真的只有 5 条」还是「后面还有 30 条没显示」。
            counts: { type: 'object', required: true, additionalProperties: true },
            changedFiles: { type: 'array', required: true, items: { type: 'string' } },
            changedFileTotal: { type: 'integer', required: true },
            readme: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            docsToRead: { type: 'array', required: true, items: { type: 'string' } },
            instruction: { type: 'string', required: true },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
            nextAction: { type: 'string', required: true },
          },
        },
        render: (_args, v) => {
          const fmt = (c) => '  - [' + c.sha + '] ' + c.date + '  ' + clampLine(c.subject, docsLineChars);
          const bucket = (title, key) => {
            const arr = v[key] ?? [];
            const total = v.counts?.[key] ?? arr.length;
            const head = title + ': ' + total + ' 条' + (arr.length < total ? '（仅列前 ' + arr.length + ' 条）' : '');
            return arr.length ? head + '\n' + arr.map(fmt).join('\n') : head;
          };
          const body =
            '📝 发布说明素材 —— ' + v.project + '\n' +
            '版本: ' + (v.previousVersion || '(未知)') + ' → ' + (v.version || '(未定)') + '\n' +
            '区间: ' + (v.from || '(未定)') + '（' + v.fromKind + '）..' + v.to + '   共 ' + v.commitCount + ' 条提交\n' +
            bucket('✅ 新增功能（可写进 README）', 'features') + '\n' +
            bucket('🚫 修复 / BUG（禁止写进 README）', 'fixes') + '\n' +
            bucket('⏭ 内部整理（README 不需要）', 'internal') + '\n' +
            bucket('❓ 需人工判断', 'ambiguous') + '\n' +
            '改动文件: ' + v.changedFileTotal + ' 个\n' +
            v.changedFiles.map((f) => '  - ' + f).join('\n') + '\n' +
            'README 目标:\n' +
            (v.readme.length
              ? v.readme
                  .map((t) => '  - ' + t.rel + '  存在=' + t.exists + '  门禁=' + t.gate + '\n      章节: ' + (t.headings.join(' / ') || '(无)'))
                  .join('\n')
              : '  - （该仓库没有 README ⇒ 跳过这一步）') + '\n' +
            '先读文档: ' + (v.docsToRead.join(', ') || '(无)') + '\n' +
            (v.warnings.length ? '注意:\n' + v.warnings.map((w) => '  - ' + w).join('\n') + '\n' : '') +
            '规则:\n' + v.instruction + '\n' +
            '下一步: ' + v.nextAction;
          return [{ type: 'text', text: clampText(body, notesBudget) }];
        },
      },
      async execute(args) {
        const base = root();
        const p = findProject(base, args.project);
        const warnings = [];
        const skeleton = {
          project: p ? p.key : String(args.project ?? ''),
          version: '',
          previousVersion: '',
          from: '',
          fromKind: 'unknown',
          to: 'HEAD',
          commitCount: 0,
          features: [],
          fixes: [],
          internal: [],
          ambiguous: [],
          counts: { features: 0, fixes: 0, internal: 0, ambiguous: 0 },
          changedFiles: [],
          changedFileTotal: 0,
          readme: [],
          docsToRead: [],
          instruction: README_INSTRUCTION,
          warnings,
          nextAction: '',
        };
        if (!p) {
          warnings.push('未知子项目：' + String(args.project ?? '') + '（可选：' + PROJECTS.map((x) => x.key).join(', ') + '）');
          return { ...skeleton, warnings, nextAction: '用正确的 project 重试。' };
        }
        const rel = p.release ?? {};
        const dir = projectDir(base, p);
        const current = readProjectVersion(base, p);
        const bumpKind = BUMP_KINDS.has(String(args.bump)) ? String(args.bump) : String(rel.bump ?? 'none');
        const previousVersion = current.version ?? '';
        const version = String(args.version ?? '').trim() || bumpVersion(previousVersion, bumpKind) || previousVersion;
        const docsToRead = docsForProject(base, p, false, '').slice(0, 4);
        if (current.conflict) {
          warnings.push(
            '版本号来源互相冲突：' +
              current.details.filter((d) => d.value).map((d) => d.label + '=' + d.value).join('；') +
              '（发布前必须先统一，否则安装包自报版本与程序集版本会对不上）',
          );
        }
        if (!existsSync(dir)) {
          warnings.push('子项目目录不存在：' + dir);
          return { ...skeleton, version, previousVersion, warnings, docsToRead, nextAction: '先用 kirara_profile 确认仓库路径。' };
        }
        if (!existsSync(join(dir, '.git'))) {
          warnings.push('不是 git 仓库（没有 .git）：拿不到「上个版本 → 本次」的提交，只能凭技术栈文档与代码文件人工整理。');
          return {
            ...skeleton,
            version,
            previousVersion,
            warnings,
            docsToRead,
            readme: inspectReadme(base, p, previousVersion, version).targets,
            nextAction: '读技术栈文档 + 本轮改动代码，只把新增功能写进 README（BUG 与修复不写）。',
          };
        }

        // 基线：显式 from > 版本号最大的祖先 tag > 首个提交（并把「区间可能偏大」说出来）。
        let from = String(args.from ?? '').trim();
        let fromKind = 'explicit';
        if (!from) {
          const tag = await latestVersionTag(dir);
          if (tag) {
            from = tag.tag;
            fromKind = 'tag';
          } else {
            from = (await rootCommit(dir)) ?? '';
            fromKind = 'root';
            warnings.push('该仓库没有任何版本 tag：已退回首个提交当基线，区间可能远大于「上一个版本」。可显式传 from 收窄。');
          }
        }
        if (!from) {
          warnings.push('无法确定基线提交（from）。');
          return { ...skeleton, version, previousVersion, warnings, docsToRead, nextAction: '显式传 from（tag 或 sha）后重试。' };
        }

        const logR = await readCommits(dir, from, 'HEAD');
        if (!logR.ok) {
          warnings.push('git log 失败：' + logR.error);
          return { ...skeleton, version, previousVersion, from, fromKind, warnings, docsToRead, nextAction: '确认 git 可用且仓库完整。' };
        }

        const buckets = { feature: [], fix: [], internal: [], ambiguous: [] };
        const counts = { feature: 0, fix: 0, internal: 0, ambiguous: 0 };
        // 按标题去重：仓库里合过分支（同一提交经另一条父链再次进入历史）时，
        // git log --no-merges 会把同一条提交的标题吐两遍。实测后端仓库 65 条里
        // 有 20 条是这种重复 —— 不去重会把「新增功能」列表灌满噪音。
        const seen = new Set();
        let duplicates = 0;
        for (const c of logR.commits) {
          const key = c.subject.trim();
          if (seen.has(key)) {
            duplicates += 1;
            continue;
          }
          seen.add(key);
          const kind = classifyCommit(c.subject);
          counts[kind] += 1;
          // 逐桶限量：一个桶塞满就不再往里放，真实条数仍然如实回报（counts）。
          if (buckets[kind].length < notesMaxCommits) {
            buckets[kind].push({ sha: c.short, date: c.date, subject: c.subject });
          }
        }
        const unique = logR.commits.length - duplicates;
        if (duplicates > 0) {
          warnings.push('已按标题折叠 ' + duplicates + ' 条重复提交（分支合并的产物），实际 ' + unique + ' 条。');
        }
        if (Object.values(counts).some((n) => n > notesMaxCommits)) {
          warnings.push('某一桶超过 ' + notesMaxCommits + ' 条，列表只列前 ' + notesMaxCommits + ' 条；真实条数见各桶标题。');
        }
        const changed = await readChangedFiles(dir, from, 'HEAD');
        // 与 kirara_release 用同一套证据口径：两边给出的门禁结论必须一致，
        // 否则会出现「素材工具说没事、发布工具却拦下」这种自相矛盾。
        const readmeInfo = inspectReadme(base, p, previousVersion, version, await collectReadmeEvidence(dir, p, from, 'HEAD'));
        if (!readmeInfo.required) {
          warnings.push('该仓库没有 README（发布画像里 readme 为空）⇒ 本轮跳过「写 README」这一步。');
        }
        return {
          project: p.key,
          version,
          previousVersion,
          from,
          fromKind,
          to: 'HEAD',
          commitCount: unique,
          features: buckets.feature,
          fixes: buckets.fix,
          internal: buckets.internal,
          ambiguous: buckets.ambiguous,
          counts: {
            features: counts.feature,
            fixes: counts.fix,
            internal: counts.internal,
            ambiguous: counts.ambiguous,
          },
          changedFiles: changed.files.slice(0, notesMaxFiles),
          changedFileTotal: changed.total,
          readme: readmeInfo.targets,
          docsToRead,
          instruction: README_INSTRUCTION,
          warnings,
          nextAction:
            readmeInfo.targets.length === 0
              ? '把上面 features 里的条目（不含 fixes）按其用户价值整理好 —— 该仓库没有 README，本轮无需写文档。'
              : '按上面的规则把 features 写进 ' + readmeInfo.targets.map((t) => t.rel).join(' / ') +
                '（fixes / internal 一律不写），然后调 kirara_release 打包发布。',
        };
      },
      presentCall: (args) => ({ card: 'generic', title: '发布说明素材: ' + args.project, kind: 'read' }),
    }),
  );

  // ── 9. kirara_release ──────────────────────────────────────────────────────
  // 本插件里**唯一有外部副作用**的一段流程：跑真实发布脚本、把产物搬到桌面、给后端打镜像标签。
  // 因此三条是硬要求：
  //   ① 计划与执行共用同一条步骤表（见 buildReleasePlan）—— 人看到的就是会跑的；
  //   ② 一切能提前判定的失败都**先**失败（版本冲突 / 签名缺失 / Docker 没起 / README 没更新），
  //      绝不先跑二十分钟再报「少个 keystore.properties」；
  //   ③ dryRun 可单独跑，把版本号与完整步骤先摆到人面前再决定。
  guard('kirara_release', () =>
    defineTool({
      name: 'kirara_release',
      description:
        "Package one Kirara sub-project and drop the artifact on the Desktop: runs the repo's own release script (desktop / media) or the tech-doc Docker flow (api), names the output with the _v<version> suffix, and writes a SHA256 checksum file. " +
        'It enforces the pre-release gate: the project README must already carry the new version, so call kirara_release_notes and update the README first. ' +
        'Use dryRun:true to see the resolved version and the exact steps without running anything.',
      parameters: {
        project: {
          type: 'string',
          required: true,
          enum: ['desktop', 'api', 'media'],
          description: 'Which sub-project to release.',
        },
        version: {
          type: 'string',
          description: "Explicit target version. Defaults to the project's current version bumped by its own rule (api: patch, others: none).",
        },
        bump: {
          type: 'string',
          enum: ['none', 'patch', 'minor', 'major'],
          description: 'How to derive the target version when version is omitted. none = re-package the current version as-is.',
        },
        dryRun: {
          type: 'boolean',
          description: 'true = only resolve the version and print the exact plan; nothing is built, copied or written.',
        },
        force: {
          type: 'boolean',
          description: 'true = proceed even though the README has not been updated to the new version (the gate is skipped on purpose).',
        },
        outputDir: {
          type: 'string',
          description: 'Where to put the artifact. Defaults to the current user Desktop (resolved via the shell folder API).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: { type: 'string', required: true },
            version: { type: 'string', required: true },
            previousVersion: { type: 'string', required: true },
            bump: { type: 'string', required: true },
            dryRun: { type: 'boolean', required: true },
            blocked: { type: 'boolean', required: true },
            blockers: { type: 'array', required: true, items: { type: 'string' } },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
            steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            ok: { type: 'boolean', required: true },
            errors: { type: 'array', required: true, items: { type: 'string' } },
            outputDir: { type: 'string', required: true },
            notes: { type: 'object', required: true, additionalProperties: true },
            nextAction: { type: 'string', required: true },
            logTail: { type: 'string' },
            artifact: { type: 'object', additionalProperties: true },
            sha256: { type: 'string' },
            checksumFile: { type: 'string' },
          },
        },
        render: (_args, v) => {
          const head = v.blocked
            ? '⛔ 发布被前置条件拦下'
            : v.dryRun
              ? '🧪 发布计划（dryRun，什么都没跑）'
              : v.ok
                ? '✅ 发布完成'
                : '❌ 发布失败';
          const body =
            head + ' —— ' + v.project + '  v' + v.version + '\n' +
            '版本: ' + (v.previousVersion || '(未知)') + ' → ' + v.version + '（bump=' + v.bump + '）\n' +
            '输出目录: ' + (v.outputDir || '(未定)') + '\n' +
            (v.blockers.length ? '阻断项:\n' + v.blockers.map((b) => '  - ' + b).join('\n') + '\n' : '') +
            (v.warnings.length ? '提醒:\n' + v.warnings.map((w) => '  - ' + w).join('\n') + '\n' : '') +
            (v.steps.length
              ? '步骤:\n' +
                v.steps.map((s, i) => '  ' + (i + 1) + '. [' + s.status + '] ' + s.title + '\n      $ ' + s.command + (s.detail ? '\n      → ' + s.detail : '')).join('\n') +
                '\n'
              : '') +
            (v.artifact ? '产物: ' + v.artifact.name + '（' + v.artifact.sizeMB + ' MB）\n      ' + v.artifact.path + '\n' : '') +
            (v.sha256 ? 'SHA256: ' + v.sha256 + '\n' : '') +
            (v.checksumFile ? '校验文件: ' + v.checksumFile + '\n' : '') +
            (v.errors.length ? '错误:\n' + v.errors.map((e) => '  - ' + e).join('\n') + '\n' : '') +
            (v.logTail ? '日志尾部:\n' + v.logTail + '\n' : '') +
            '下一步: ' + v.nextAction;
          return [{ type: 'text', text: clampText(body, releaseBudget) }];
        },
      },
      async execute(args) {
        const base = root();
        const p = findProject(base, args.project);
        const blockers = [];
        const gate = [];
        const warnings = [];
        if (!p) {
          return {
            project: String(args.project ?? ''),
            version: '',
            previousVersion: '',
            bump: 'none',
            dryRun: args.dryRun === true,
            blocked: true,
            blockers: ['未知子项目：' + String(args.project ?? '') + '（可选：' + PROJECTS.map((x) => x.key).join(', ') + '）'],
            warnings,
            steps: [],
            ok: false,
            errors: [],
            outputDir: '',
            notes: { required: false, satisfied: true, targets: [], instruction: README_INSTRUCTION },
            nextAction: '用正确的 project 重试。',
          };
        }
        const rel = p.release ?? {};
        const dir = projectDir(base, p);
        const dryRun = args.dryRun === true;
        const force = args.force === true;

        if (!existsSync(dir)) blockers.push('子项目目录不存在：' + dir);

        // ── 版本号 ───────────────────────────────────────────────────────────
        const current = readProjectVersion(base, p);
        const bumpKind = BUMP_KINDS.has(String(args.bump)) ? String(args.bump) : String(rel.bump ?? 'none');
        const previousVersion = current.version ?? '';
        const explicit = String(args.version ?? '').trim();
        const version = explicit || bumpVersion(previousVersion, bumpKind) || '';
        if (!version) {
          blockers.push(
            '无法确定发布版本号：来源 = ' +
              (current.details.length ? current.details.map((d) => d.label + '(' + (d.value ?? d.status) + ')').join('；') : '该项目未声明任何版本来源') +
              '。请显式传 version。',
          );
        }
        if (current.conflict) {
          blockers.push(
            '版本号来源互相冲突，必须先统一：' + current.details.filter((d) => d.value).map((d) => d.label + '=' + d.value).join('；'),
          );
        }

        // ── 输出目录 ─────────────────────────────────────────────────────────
        const requested = String(args.outputDir ?? '').trim() || configuredOutputDir;
        const outDir = requested ? resolve(requested) : await resolveDesktop();
        if (!outDir) blockers.push('无法确定输出目录：请用 outputDir 显式指定（桌面路径解析失败）。');

        // ── 前置检查：能在这里一秒失败的，绝不放到二十分钟后 ───────────────────
        for (const pf of rel.preflight ?? []) {
          if (pf.kind === 'file' && !existsSync(join(dir, pf.file))) {
            blockers.push('缺 ' + pf.file + '：' + pf.why);
          }
        }
        if ((rel.preflight ?? []).some((pf) => pf.kind === 'docker')) {
          const dr = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], dir, 30000);
          if (!dr.ok) {
            blockers.push(
              'Docker 守护进程不可用（docker build / docker save 都需要它）：请先启动 Docker Desktop。原始输出：' +
                tail((dr.stderr || dr.stdout || '').trim(), 2),
            );
          }
        }

        // ── README 门禁 ──────────────────────────────────────────────────────
        // 用户要求「发布前必须把本版本的新功能写进 README」。门禁靠证据，分三级（见 inspectReadme）。
        // 基线取 HEAD 上版本号最大的 tag = 上一个发布版本；没有 tag 就只能退化为「无法核验」。
        let gateBase;
        let evidence;
        if ((rel.readme ?? []).length > 0 && existsSync(join(dir, '.git'))) {
          gateBase = (await latestVersionTag(dir))?.tag;
          evidence = await collectReadmeEvidence(dir, p, gateBase, 'HEAD');
        }
        const notes = inspectReadme(base, p, previousVersion, version, evidence);
        for (const t of notes.targets) {
          if (t.gate === 'stale') {
            gate.push('README 未更新到本版本：' + t.rel + ' 里还是 ' + previousVersion + '，应改为 ' + version + '（先用 kirara_release_notes 取「新增功能」）');
          } else if (t.gate === 'unchanged') {
            gate.push(
              'README 自上个版本（' + (gateBase ?? '?') + '）以来没有任何改动：本轮的新增功能还没写进 ' + t.rel +
                '。先用 kirara_release_notes 取素材再更新它',
            );
          } else if (t.gate === 'missing') {
            gate.push('发布画像里列了 README 但文件不存在：' + t.rel);
          } else if (t.gate === 'unverifiable') {
            warnings.push(t.rel + ' 既不写版本号、也没有可用的 git 证据，无法核验本轮新增功能是否已写入 —— 请人工确认');
          }
        }
        if (force && gate.length > 0) {
          for (const g of gate) warnings.push('已被 force 跳过：' + g);
        }

        const blocked = blockers.length > 0 || (!force && gate.length > 0);
        const steps = [];
        let log = '';
        let artifactName;
        let sha;
        let checksumFile;
        let ok = false;

        if (!blocked) {
          const plan = buildReleasePlan({ root: base, project: p, version, outDir, timeoutMs: releaseTimeout });
          if (dryRun) {
            for (const s of plan) steps.push({ id: s.id, title: s.title, command: s.command, status: 'planned' });
            ok = true;
          } else {
            ok = true;
            for (const s of plan) {
              const r = await s.run();
              if (r.log) log += '\n[#' + s.id + ']\n' + r.log;
              steps.push({
                id: s.id,
                title: s.title,
                command: s.command,
                status: r.status,
                ...(r.detail === undefined ? {} : { detail: r.detail }),
              });
              if (r.artifactName !== undefined) artifactName = r.artifactName;
              if (r.sha256 !== undefined) sha = r.sha256;
              if (r.checksumFile !== undefined) checksumFile = r.checksumFile;
              if (r.status !== 'ok') {
                ok = false;
                break;
              }
            }
          }
        }

        let artifact;
        if (!dryRun && artifactName && outDir) {
          const abs = join(outDir, artifactName);
          if (existsSync(abs)) {
            const st = statSync(abs);
            artifact = { name: artifactName, path: abs, sizeBytes: st.size, sizeMB: Math.round((st.size / 1048576) * 10) / 10 };
          }
        }

        // ⚠️ 名字不能叫 logTail：外层闭包里的 logTail 是「取多少行」的配置常量，
        // 同名会让这个 const 的初始化式自引用，直接抛 TDZ（Cannot access 'logTail' before initialization）。
        const releaseLogTail = log.trim()
          ? clampText(
              tail(log.trim(), logTail)
                .split(/\r?\n/)
                .map((line) => clampLine(line, buildLineChars))
                .join('\n'),
              releaseBudget,
            )
          : '';

        const nextAction = blocked
          ? '按 blockers 逐条修掉后重跑；README 那条可先调 kirara_release_notes 取素材。（确要跳过 README 门禁时传 force:true）'
          : dryRun
            ? '确认版本号与步骤无误后，去掉 dryRun 重跑即真正发布。'
            : ok
              ? '发布完成：产物与校验码都在 ' + outDir + '。可把产物路径交给 present，并跑 kirara_summary 收尾。'
              : '看上面的 status/errors/logTail 定位失败的步骤；修好后直接重跑（已完成的步骤会重做一遍）。';

        return {
          project: p.key,
          version,
          previousVersion,
          bump: bumpKind,
          dryRun,
          blocked,
          blockers: [...blockers, ...(force ? [] : gate)],
          warnings,
          steps,
          ok,
          errors: extractErrors(log).map((e) => clampLine(e, buildLineChars)),
          outputDir: outDir,
          notes,
          nextAction,
          ...(releaseLogTail ? { logTail: releaseLogTail } : {}),
          ...(artifact === undefined ? {} : { artifact }),
          ...(sha === undefined ? {} : { sha256: sha }),
          ...(checksumFile === undefined ? {} : { checksumFile }),
        };
      },
      presentCall: (args) => ({ card: 'generic', title: '发布 ' + args.project, kind: 'execute' }),
    }),
  );

  // ── 11. kirara_ui ──────────────────────────────────────────────────────────
  // 追加在末尾（与既有约定一致：注册顺序就是 DSH 记进 request/header 的工具顺序，
  // 新增工具本来就换一次快照，不再额外打乱已有工具的位置）。
  //
  // 它**不是**又一个「构建 + 截图」工具：kirara_build(target=ios) 那条路是一次性的
  // 全量自检（约 4 分钟、4 张固定截图）。这里要的是**内环** —— 想看一眼就看一眼，
  // 想看哪屏就把屏幕开过去再截，每轮只等一次增量构建。
  guard('kirara_ui', () =>
    defineTool({
      name: 'kirara_ui',
      description:
        'Live visual loop for Kirara_Media UI work (iOS + Android). It discovers which device-control MCP servers this host actually exposes, captures or adopts a screenshot into a numbered evidence trail, and records design-iteration rounds — so a UI change is looked at while it is being made, not after a 4-minute self-test. ' +
        'Run it with action=plan BEFORE writing UI code, then action=shot (look) → fix → action=review (record) per round. ' +
        'action=status is what kirara_verify / kirara_summary read: UI work with no iteration round gets flagged instead of silently passing.',
      parameters: {
        action: {
          type: 'string',
          enum: ['plan', 'shot', 'review', 'status'],
          description:
            'plan（默认）=发现 MCP 与设备 + 给出这一轮该怎么转；shot=抓一张或采纳已有截图进编号证据；' +
            'review=记一轮迭代（issues 非空 = 还没改完；空 = 收敛）；status=只看当前环的状态与闭环判据。',
        },
        platform: {
          type: 'string',
          enum: ['auto', 'ios', 'android'],
          description:
            'auto（默认）：macOS → ios、其它 → android。设备在哪台机器上跑就以哪个为准（Mac 侧只做 iOS）。',
        },
        paths: {
          type: 'array',
          description:
            'action=shot 时采纳的已有截图绝对路径（例如 Xcode MCP 的 DeviceInteractionSynthesize 回传的 PNG）。' +
            '留空 = 直接用 simctl / adb 抓当前屏幕；两种都在，缺 MCP 也不至于停摆。',
          items: { type: 'string' },
        },
        note: {
          type: 'string',
          description: '这一轮改了什么 / 要看哪一屏，写进证据链便于回看（一句就够）。',
        },
        issues: {
          type: 'array',
          description:
            'action=review：看完截图后确认要改的 P0/P1 条目，一条一句，写成「改哪个控件/文件 → 改成什么」。' +
            '空数组 = 这轮没有要改的（收敛）。',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            platform: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
            loopDir: { type: 'string', required: true },
            device: { type: 'string', required: true },
            mcp: { type: 'array', required: true, items: { type: 'string' } },
            shots: { type: 'array', required: true, items: { type: 'string' } },
            iterations: { type: 'integer', required: true },
            shotCount: { type: 'integer', required: true },
            openIssues: { type: 'integer', required: true },
            closed: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const base = root();
        const p = findProject(base, 'media');
        const dir = projectDir(base, p);
        const actionRaw = String(args.action || 'plan');
        const action = ['plan', 'shot', 'review', 'status'].includes(actionRaw) ? actionRaw : 'plan';
        const requested = String(args.platform || 'auto');
        const platform = requested === 'ios' || requested === 'android' ? requested : IS_MAC ? 'ios' : 'android';
        const loopDir = uiLoopRoot(base, p, config.uiLoopDir);
        const stateFile = uiStatePath(loopDir);
        const state = readUiState(stateFile, platform);
        const note = String(args.note || '').trim();
        const givenPaths = asStringList(args.paths).slice(0, maxShots);
        const givenIssues = asStringList(args.issues).slice(0, 24);
        const timeout = config.uiLoopTimeoutMs ?? 120000;

        // MCP 发现（只读）：definitions() 是宿主解析后的真实集合，MCP 客户端注册的那些也在里面。
        // 拿不到就当作「没有 MCP」——兜底桥照样能截图，环不该因为一次读表失败而停。
        let toolNames = [];
        let discoveryError = '';
        try {
          toolNames = ctx.tools.definitions().map((def) => def?.name).filter((n) => typeof n === 'string');
        } catch (error) {
          discoveryError = String(error?.message ?? error);
        }
        const mcp = discoverUiMcp(toolNames);
        const mcpLines = mcp.length
          ? mcp.map((entry) => `  ${describeUiMcp(entry)}`)
          : [
              discoveryError
                ? `  （读不到宿主工具表：${discoveryError.slice(0, 80)} —— 按没有 MCP 处理，用 simctl / adb 兜底）`
                : '  （没发现设备控制类 MCP：下面用 simctl / adb 兜底，一样能出图）',
            ];

        /** 统一的返回形状：所有分支都走它，避免某个分支漏字段被宿主拒收。 */
        const respond = (ok, body, extra = {}) => ({
          action,
          platform,
          ok,
          text: clampText(body, uiBudget),
          loopDir,
          device: extra.device ?? '',
          mcp: mcp.map((entry) => describeUiMcp(entry)),
          shots: extra.shots ?? [],
          iterations: Number(state.iterations) || 0,
          shotCount: Array.isArray(state.shots) ? state.shots.length : 0,
          openIssues: Array.isArray(state.openIssues) ? state.openIssues.length : 0,
          closed: Boolean(extra.closed),
        });

        if (!existsSync(dir)) {
          return respond(
            false,
            [
              `找不到 media 仓库：${dir}`,
              `workspaceRoot 当前解析成 ${base} —— 这个目录下必须有 ${p.dir}（或同名小写）。`,
              '改法：在 profile 的 cordis.patch.yml 里给 kirara-dev 配 workspaceRoot，或设 DSH_WORKSPACE。',
            ].join('\n'),
          );
        }

        const loopLine = () =>
          `截图 ${(Array.isArray(state.shots) ? state.shots : []).length} 张 / 迭代 ${Number(state.iterations) || 0} 轮 / ` +
          `未修 ${(Array.isArray(state.openIssues) ? state.openIssues : []).length} 条`;

        const axesBlock = () => ['看截图时按这 8 条逐条给「改哪个文件/控件 → 改成什么」：', ...UI_REVIEW_AXES.map((a) => `- ${a}`)].join('\n');

        // ── status：只读，供 verify / summary 与「现在到底闭环没有」共用 ──────────
        if (action === 'status') {
          const summary = readUiLoopSummary(base, p, config.uiLoopDir);
          const body = [
            `实时视觉环（media · ${summary.platform || platform}）`,
            `证据目录: ${summary.root}`,
            `状态: 截图 ${summary.shots} 张 / 迭代 ${summary.iterations} 轮 / 未修 P0-P1 ${summary.openIssues.length} 条 → ${summary.closed ? '已闭环 ✅' : '未闭环 ⚠️'}`,
            ...(summary.openIssues.length ? ['未修条目:', ...summary.openIssues.slice(0, 6).map((i) => `  - ${i}`)] : []),
            summary.closed
              ? '可以走 kirara_build + kirara_verify(purpose="ui-design") 收尾。'
              : 'UI 改动未闭环之前不要宣称「已经对齐 / 和设计一致」：先 kirara_ui(action="shot") 看一眼。',
          ].join('\n');
          return respond(true, body, { closed: summary.closed });
        }

        // ── review：记一轮迭代（不碰设备，设备此刻掉线不该让「记录」失败）──────────
        if (action === 'review') {
          state.platform = platform;
          state.iterations = (Number(state.iterations) || 0) + 1;
          state.lastReviewAt = new Date().toISOString();
          const seenShots = (Array.isArray(state.shots) ? state.shots : []).length;
          if (givenIssues.length) {
            state.openIssues = givenIssues;
          } else {
            state.openIssues = [];
          }
          writeUiState(stateFile, state);
          const closed = seenShots > 0 && state.openIssues.length === 0;
          const lines = [
            `第 ${state.iterations} 轮 review（media · ${platform}）—— ${loopLine()}`,
          ];
          if (givenIssues.length) {
            lines.push(
              '',
              `记下 ${givenIssues.length} 条待改：`,
              ...givenIssues.slice(0, 8).map((i) => `  - ${i}`),
              givenIssues.length > 8 ? `  …（还有 ${givenIssues.length - 8} 条已入状态）` : '',
              '',
              '下一步：改代码 → kirara_build（增量）→ kirara_ui(action="shot") 重截 → 再看一遍。',
              '这些条目没清空之前，本轮 UI 改动算「未收敛」，不要写进总结当已完成。',
            );
          } else if (seenShots === 0) {
            lines.push(
              '',
              '⚠️ 还没有任何截图就宣告收敛：这等于没看过。先 kirara_ui(action="shot") 截一张再 review。',
            );
          } else {
            lines.push('', '✅ 这一轮无未修项：视觉环闭环。可以 kirara_build + kirara_verify(purpose="ui-design") 收尾。');
          }
          if (note) lines.push('', `本轮说明：${note}`);
          return respond(true, lines.filter((l) => l !== '').join('\n'), { closed });
        }

        // ── plan / shot 都需要设备真身：现在探一次（设备是外部状态，缓存它只会给过期结论）──
        const device =
          action === 'plan' || givenPaths.length === 0
            ? platform === 'ios'
              ? await probeIosDevice(dir, timeout, p.ios?.device ?? '')
              : await probeAndroidDevice(dir, timeout)
            : null;
        const deviceLine = device
          ? device.ok
            ? platform === 'ios'
              ? `${device.name} (${device.udid.slice(0, 8)}…) ${device.booted ? '已启动' : '未启动'}`
              : `${device.serial} 在线`
            : `⚠️ ${device.error}`
          : '';

        // ── shot：抓一张 / 采纳已有截图，编号落进证据目录 ─────────────────────────
        if (action === 'shot') {
          const captured = [];
          const failures = [];
          const saved = state;
          const record = (target) => {
            // 文件名里的编号由 nextShotIndex 决定；这里只补记录，不重新命名。
            saved.shots = [...(Array.isArray(saved.shots) ? saved.shots : []), { path: target, at: new Date().toISOString(), note }];
            captured.push(target);
          };

          if (givenPaths.length) {
            try {
              mkdirSync(loopDir, { recursive: true });
            } catch {
              /* 目录已存在 / 无权限：下面的 copy 会给出真实错误 */
            }
            for (const raw of givenPaths) {
              const abs = resolve(expandHome(raw));
              if (!existsSync(abs)) {
                failures.push(`${raw}（文件不存在：不要凭文件名猜内容，先确认路径）`);
                continue;
              }
              const ext = (/\.(png|jpe?g|webp)$/i.exec(abs)?.[0] ?? '.png').toLowerCase();
              const idx = nextShotIndex(loopDir, (Array.isArray(saved.shots) ? saved.shots : []).length);
              const target = join(loopDir, `shot-${String(idx).padStart(2, '0')}${ext}`);
              try {
                if (resolve(target) !== abs) copyFileSync(abs, target);
                record(target);
              } catch (error) {
                failures.push(`${raw}（复制失败：${String(error?.message ?? error)}）`);
              }
            }
          } else {
            if (!device?.ok) {
              return respond(
                false,
                [
                  `抓不到截图（media · ${platform}）：${device?.error ?? '设备探测失败'}`,
                  device ? `命令: ${device.command}` : '',
                  'MCP:',
                  ...mcpLines,
                  '',
                  '修好设备后重跑；或在别处拿到截图后用 kirara_ui(action="shot", paths=[...]) 采纳进来。',
                ]
                  .filter((l) => l !== '')
                  .join('\n'),
                { device: deviceLine },
              );
            }
            try {
              mkdirSync(loopDir, { recursive: true });
            } catch {
              /* 同上 */
            }
            const idx = nextShotIndex(loopDir, (Array.isArray(saved.shots) ? saved.shots : []).length);
            const target = join(loopDir, `shot-${String(idx).padStart(2, '0')}.png`);
            const cap = await captureShot(device, target, dir, timeout);
            if (cap.ok) record(target);
            else failures.push(`截图失败：${cap.error}`);
          }

          if (captured.length) {
            saved.platform = platform;
            writeUiState(stateFile, saved);
            state.shots = saved.shots;
            state.platform = platform;
          }
          const body = [
            `${captured.length ? `截了 ${captured.length} 张` : '没拿到截图'}（media · ${platform}）${deviceLine ? ` · 设备 ${deviceLine}` : ''}`,
            ...captured.map((c) => `  - ${c}`),
            ...(failures.length ? ['失败:', ...failures.map((f) => `  - ${f}`)] : []),
            captured.length
              ? '下一步（顺序别换）：① 用 read_image 逐张看；② 再按下面 8 条给可落地修改项。'
              : '先修上面这些失败项；实在拿不到设备截图时，用 kirara_ui(action="shot", paths=[每张绝对路径]) 采纳别处的截图。',
            captured.length ? axesBlock() : '',
            captured.length ? `当前 ${loopLine()}；改完再 kirara_ui(action="review", issues=[...]) 记一轮。` : '',
          ]
            .filter((l) => l !== '')
            .join('\n');
          return respond(captured.length > 0, body, { shots: captured, device: deviceLine, closed: false });
        }

        // ── plan：把「这一轮怎么转」写死成可执行顺序 ─────────────────────────────
        const plan = p.ios ? iosPlan(p.ios, dir) : null;
        const xcode = mcp.find((entry) => /xcode|ios|apple/i.test(entry.namespace));
        // 驱动工具要按端挑：同时装着 xcode 与 adb 两个服务时，Android 的计划不能写
        // 「用 DeviceInteractionSynthesize 点」—— 那是模拟器手势，接到安卓上不成立。
        const nativeFirst = mcp.filter((entry) => (/xcode|ios|apple/i.test(entry.namespace) ? platform === 'ios' : platform === 'android'));
        const driver = (nativeFirst.find((entry) => entry.driver) ?? mcp.find((entry) => entry.driver))?.driver ?? '';
        // RenderPreview 只覆盖 SwiftUI 壳（iOS），Android 上不出现，免得当成通用快通道。
        const preview = platform === 'ios' ? (nativeFirst.find((entry) => entry.preview) ?? mcp.find((entry) => entry.preview))?.preview ?? '' : '';
        const iosSteps = [
          `1. 起设备并装包：${plan ? plan.script.line : 'bash iosApp/run-simulator.sh'}` +
            (xcode?.app ? `（或在 Xcode MCP 里走 ${xcode.app}）` : '') +
            ' —— 一次把「构建 + 装模拟器 + 启动」做完；之后每轮只走增量。',
          '2. 看一眼：kirara_ui(action="shot")，拿到路径后用 read_image 真正看图（这一步不能跳）。',
          driver
            ? `3. 走到目标界面：simctl 不能点、不能打字 → 用 ${driver}（tap 传坐标、type 传文本）；点完再 shot 一次。`
            : '3. 走到目标界面：没发现可点按的 MCP → 用 DeviceHub 人肉点，或改 run-simulator.sh 的自检开关直达该屏。',
          "4. 改代码 → kirara_build({ project: 'media', target: 'ios' })（增量链接）→ 回第 2 步。",
          '5. 收敛：kirara_ui(action="review", issues=[]) → kirara_build + kirara_verify(purpose="ui-design") 收尾。',
        ];
        const androidSteps = [
          `1. 装包并启动：${adbExe()} install -r ${p.apk} → ${adbExe()} shell monkey -p ${ANDROID_APP_ID} 1` +
            '（debug 变体的包名带 .debug 后缀，装错包会看到旧界面）。',
          '2. 看一眼：kirara_ui(action="shot")，再用 read_image 看图（这一步不能跳）。',
          driver
            ? `3. 走到目标界面：${driver}（或 adb shell input tap X Y / input text ...），到点后再 shot 一次。`
            : `3. 走到目标界面：${adbExe()} shell input tap X Y / input text ...，到点后再 shot 一次。`,
          "4. 改代码 → kirara_build({ project: 'media', target: 'android' }) → 回第 1 步（重装 debug 包）。",
          '5. 收敛：kirara_ui(action="review", issues=[]) → kirara_build + kirara_verify(purpose="ui-design") 收尾。',
        ];
        const body = [
          `实时视觉环（media · ${platform}）`,
          deviceLine ? `设备: ${deviceLine}` : '',
          `证据: ${loopDir}   当前 ${loopLine()}`,
          'MCP:',
          ...mcpLines,
          preview ? `预览快通道: ${preview}（只覆盖 SwiftUI 壳；:shared 的 Compose UI 仍要走上面 1–4）` : '',
          '',
          '按这个顺序转（每轮只等一次增量构建 + 一张截图，不再等全量自检）:',
          ...(platform === 'ios' ? iosSteps : androidSteps),
          '',
          axesBlock(),
          '',
          '规则：review 里还有 issues 就不算完成；连着看两张都没发现新问题，才有资格写总结。',
        ]
          .filter((l) => l !== '')
          .join('\n');
        return respond(true, body, { device: deviceLine, closed: false });
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `实时视觉环 (${args.action || 'plan'})`,
        kind: 'other',
        rawInput: args.platform,
      }),
    }),
  );

  if (failed.length > 0 || registered.length !== NOMINAL_TOOLS.length) {
    console.error(
      `[kirara-dev] 工具集合与预期不一致：已注册 ${registered.length}/${NOMINAL_TOOLS.length}` +
        `（${registered.join(', ') || '无'}）` +
        (failed.length > 0 ? `；注册失败：${failed.join(', ')}` : '') +
        '。\n  为什么这会影响缓存命中率：DSH 会把 request/header（config + tools 的 JSON 快照）' +
        '记进会话，工具集合一旦与上次启动不一致，就会开一条新的 request series，' +
        '并原地改写对话最前面的系统提示节点 —— 整段前缀缓存作废。' +
        '\n  修复定义后跑 node scripts/deploy.mjs 重新部署并完全重启 DSH。',
    );
  }
}
