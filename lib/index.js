/**
 * @kirara/dsh-plugin-kirara-dev
 *
 * Kirara 多端项目（kirara_server / kirara_-server-api / Kirara_Media）的 DSH 开发流程编排插件。
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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

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
});

// ─────────────────────────────────────────────────────────────────────────────
// 项目画像：三端的构建/验证事实（均由实机实测确认，见 README）
// ─────────────────────────────────────────────────────────────────────────────

const PROJECTS = [
  {
    key: 'desktop',
    dir: 'kirara_server',
    title: 'Kirara_Server WinUI 3 桌面客户端',
    stack: 'WinUI 3 (Windows App SDK 2.3.1) + C# 13 + .NET 10 + CommunityToolkit.Mvvm 8.4 + LiteDB',
    tfm: 'net10.0-windows10.0.19041.0',
    build: {
      // ⚠️ 该 slnx 只注册了 x64 平台，必须显式传 -p:Platform=x64
      cmd: 'dotnet',
      args: ['build', 'Kirara_Server-WinUI.slnx', '-c', 'Debug', '-p:Platform=x64', '--nologo'],
    },
    publish: { cmd: 'dotnet', args: ['publish', '-c', 'Release', '-p:Platform=x64'] },
    specs: 'Kirara_Server-WinUI.slnx',
    docs: ['docs/技术栈文档.md', 'docs/需求文档.md', 'AGENTS.md'],
    constraints: [
      'WebView2 的 EnsureCoreWebView2Async() 必须在 UI 线程调用',
      'WinUI3 的 PasswordBox 不支持直接 MVVM 绑定，需 code-behind 中转',
      'app.manifest 的 requireAdministrator 不可移除（TAP/Wintun 网卡需要）',
      'XAML 主题色必须用 {StaticResource KiraraAccentColorBrush}，禁止 {ThemeResource SystemAccentColor}（加载期固化）',
      '图标字体必须用 {StaticResource KiraraIconFontFamily}，禁止硬编码 Segoe Fluent Icons / Segoe MDL2 Assets',
      '新集合索引须在 AppDatabase.Initialize() 集中注册（用户切换重开库后必须重建）',
    ],
  },
  {
    key: 'api',
    dir: 'kirara_-server-api',
    title: 'Kirara_Server-API 后端服务',
    stack: 'ASP.NET Core 10 + Aspire 13.2.4 + PostgreSQL 16/EF Core 10 + Redis + MinIO + SignalR',
    build: {
      // ⚠️ 不要构建 .slnx：它引用了不存在的 test-assets/DbCheck/DbCheck.csproj，
      //    整解构建会以 MSB3202 立即失败（0.8s）。改构建 Server 项目（会带出 Core/Infrastructure/Shared）。
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
      'AGENTS.md',
    ],
    constraints: [
      'slnx 存在悬空引用 test-assets/DbCheck/DbCheck.csproj —— 构建单项目绕开，或补齐/移除该 Folder 节点',
      '统一响应格式 ApiResponse<T>：{ success, data, timestamp } / { success, error, timestamp }',
      '客户端接入遵循「新建 Remote*Service 实现 I*Service + DI 替换注册」，无需改 ViewModel/UI',
      '数据库初始化走手动 SQL：psql -h localhost -p 5888 -U kirara -d kirara -f docs/sql/init.sql',
    ],
  },
  {
    key: 'media',
    dir: 'Kirara_Media',
    title: 'Kirara_Media Android 客户端',
    stack: 'Kotlin + Jetpack Compose + Hilt + OkHttp + Coil + kotlinx.serialization',
    build: {
      cmd: 'gradlew.bat',
      args: ['assembleDebug', '--console=plain'],
    },
    apk: 'app/build/outputs/apk/debug/app-debug.apk',
    specs: 'settings.gradle.kts',
    // 原值指向 规划文档.md —— 该文件在仓库里并不存在，于是 kirara_start 对 media 端
    // 推荐了一篇读不到的文档。改成实际存在的那一篇（276 KB 的主技术栈文档）。
    docs: ['app/docs/Kirara Media 安卓版技术栈文档.md', 'README.md'],
    constraints: [
      '不跑单元测试（用户明确要求）：验证 = gradlew assembleDebug + 用户手动真机测试',
      'versionCode 每次对外发布必须递增；覆盖升级须用同一 release keystore 签名',
      'Gradle 9.6.0 / JDK 17 / Android SDK 37；依赖走阿里云镜像',
      '构建后清理用 gradlew --stop（安全，只影响 Gradle）',
    ],
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
      /Task :.*FAILED/i.test(line)
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

/** 跑一个子进程，收集 stdout+stderr，带超时与取消。 */
function runProcess(cmd, args, cwd, timeoutMs) {
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
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
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
  { re: /android|安卓|手机|apk|compose|kotlin|gradle/i, key: 'media' },
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
    return { keys: docKeys, decisions: [], deviceRequired: false, reasons, uiChange, docsOnly: true };
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

  // 实机验证诉求：界面改动无论哪端都要看效果；Android 端一律以真机为准。
  const deviceRequired = uiChange || keys.has('media');

  if (uiChange && !small) {
    decisions.push({
      id: 'ui-verify',
      blocking: false,
      question: '本次是用户可见的界面变更，实机验收要点由谁定？',
      options: ['按 kirara_verify 的默认清单', '我来补充验收要点（哪些界面状态/主题/分辨率）'],
      recommend: '按 kirara_verify 的默认清单',
    });
  }
  if (!small && keys.has('media')) {
    decisions.push({
      id: 'device',
      blocking: false,
      question: 'Android 端改动需要真机验证，本次是现在跑真机还是先出测试清单等你方便时跑？',
      options: ['先出测试清单', '现在就实机验证'],
      recommend: '先出测试清单',
    });
  }
  return { keys: [...keys], decisions, deviceRequired, reasons, uiChange, docsOnly: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 文档同步（kirara_docsync）
//
// 为什么要有这一段：README / docs 下的 md 是模型的作业依据（AGENTS.md 的约束、API 文档的
// 端点表、需求文档的功能现状），但它们不会因为代码改了而自己更新。新功能落地、BUG 修完，
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
    when: /技术栈|依赖|框架|版本|升级|sdk|nuget|gradle|kotlin|compose|winui|\.net\b|ef core|postgres|redis|minio|aspire|架构|连接字符串/i,
    docs: {
      desktop: ['docs/技术栈文档.md'],
      api: ['docs/服务端后端系统技术栈.md'],
      media: ['app/docs/Kirara Media 安卓版技术栈文档.md'],
    },
    why: '技术栈 / 依赖 / 架构变化 ⇒ 技术栈文档',
  },
  {
    id: 'requirement',
    when: /需求|功能|交互|流程|体验|界面|ui\b|首页|评论|设置|登录|收藏|通知|列表|页面|上传|下载/i,
    docs: { desktop: ['docs/需求文档.md'], media: ['app/docs/Kirara Media 安卓版技术栈文档.md'] },
    why: '功能 / 交互行为变化 ⇒ 需求文档（desktop）或技术栈文档的落地记录章节（media）',
  },
  {
    id: 'readme',
    when: /安装|用法|使用说明|上手|发版|发布|版本号|下载|apk|release|部署/i,
    docs: { desktop: ['README.md'], api: ['README.md'], media: ['README.md'] },
    why: '安装 / 发版 / 用法变化 ⇒ README',
  },
  {
    id: 'agents',
    when: /约束|构建命令|构建|流程|规范|平台|slnx|x64|assemble|权限|红线/i,
    docs: { desktop: ['AGENTS.md'], api: ['AGENTS.md'], media: ['AGENTS.md'] },
    why: '约束 / 构建流程变化 ⇒ AGENTS.md（模型侧的作业规范）',
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
  ui: '界面/交互改动 —— 界面契约（入口、状态、主题）变了，需求/技术栈文档要跟上',
  docs: '文档本身的编写/同步',
  chore: '纯内部整理 —— 无对外行为变化，通常只需在更新记录留一条',
};

/**
 * 选出本次该同步的文档。
 * @returns {{picked: object[], missing: string[]}}
 */
function pickDocTargets(root, keys, feature, changes, maxTargets) {
  const hay = `${feature}\n${changes.join('\n')}`;
  const tokens = featureTokens(feature, changes);
  const picked = [];
  const missing = [];
  for (const key of keys) {
    const p = findProject(root, key);
    if (!p) continue;
    const dir = projectDir(root, p);
    const per = [];
    for (const rule of DOC_RULES) {
      if (!rule.when.test(hay)) continue;
      for (const rel of rule.docs[key] ?? []) {
        const full = join(dir, rel);
        if (!existsSync(full)) {
          const tag = `${key}:${rel}`;
          if (!missing.includes(tag)) missing.push(tag);
          continue;
        }
        if (per.some((t) => t.rel === rel)) continue;
        per.push({ project: key, rel, abs: full, why: rule.why });
      }
    }
    // 一条规则都没命中时，退回该端 PROJECTS.docs 里第一篇真实存在的文档（README 除外：
    // 它只在安装/用法变化时才是对的目标，不该被当成兜底垃圾场）。
    if (per.length === 0) {
      for (const rel of p.docs ?? []) {
        if (/readme/i.test(rel)) continue;
        const full = join(dir, rel);
        if (existsSync(full)) {
          per.push({ project: key, rel, abs: full, why: '该端主文档（未命中具体规则时的兜底）' });
          break;
        }
      }
    }
    picked.push(...per.slice(0, 3));
  }
  return { picked: picked.slice(0, maxTargets), missing, tokens };
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

        const targets = keys.map((k) => {
          const p = findProject(root(), k);
          return {
            key: p.key,
            title: p.title,
            dir: p.dir,
            buildLine: `${p.build.cmd} ${p.build.args.join(' ')}`,
            apk: p.apk ?? null,
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
              docs: (p.docs ?? []).slice(0, 4),
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
              small
                ? 'mode=small：构建成功即结束，不做实机验证'
                : 'kirara_verify 产出分步实机测试清单交用户执行',
              // UI 改动的截图复核是必经环节：不看截图就改样式等于盲改。
              ...(uiChange
                ? [
                    'UI 必经：截图 → kirara_verify(purpose=ui-design, screenshots=[...]) → 按 P0/P1 建议改 → 重截复核',
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
        'Use this instead of reading the very large AGENTS.md / copilot-instructions.md files. Pass project to narrow it to one end.',
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
                  `- [${p.key}] ${p.title}\n    build: ${p.buildLine}\n    docs:  ${(p.docs || []).join(', ')}`,
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
            buildLine: `${p.build.cmd} ${p.build.args.join(' ')}`,
            build: p.build,
            publish: p.publish ?? null,
            run: p.run ?? null,
            apk: p.apk ?? null,
            specs: p.specs,
            docs: p.docs,
            constraints: p.constraints,
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
        'Keyword search across the Kirara technical docs; returns file:line, the enclosing section heading, and the matched text. ' +
        'Use it instead of reading whole documents (some are 200 KB+). Keywords are OR-matched; narrow with project or file when hits are truncated.',
      parameters: {
        keywords: {
          type: 'array',
          required: true,
          description: 'Keywords to search for (case-insensitive, OR-matched). CJK substrings work.',
          items: { type: 'string' },
        },
        project: {
          type: 'string',
          description: 'Optional: restrict to one sub-project: desktop | api | media.',
          enum: ['desktop', 'api', 'media'],
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
            hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            scannedFiles: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => {
          if (!value.hits.length) {
            return [{ type: 'text', text: `无命中（扫描 ${value.scannedFiles} 个文件）` }];
          }
          // 命中行会永久留在会话上下文里。超预算就地停手，并明确告诉模型怎么收窄 ——
          // 这比一次灌进十几 KB、把上下文推向 compaction 便宜得多。
          const all = value.hits.map((h) => `${h.file}:${h.line}  [${h.section || '-'}]\n    ${h.text}`);
          const { lines, truncated, omitted } = budgetLines(all, docsBudget);
          const cut = truncated || value.truncated;
          return [
            {
              type: 'text',
              text:
                lines.join('\n') +
                (cut
                  ? `\n… 结果被截断${omitted > 0 ? `（本次仍有 ${omitted} 行未回传）` : ''}：` +
                    `受 ${docsBudget} 字符预算限制。收窄查询 —— 传 project / file，或改用更具体的关键词。`
                  : ''),
            },
          ];
        },
      },
      execute(args) {
        const base = root();
        const keywords = (args.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
        // 默认 12（原为 40）；上限 40。命中行会永久留在上下文里，宁少勿多。
        const maxHits = Math.max(1, Math.min(args.maxHits ?? docsMaxHits, 40));
        const scoped = args.project ? PROJECTS.filter((p) => p.key === args.project) : PROJECTS;

        // 文档范围：各端 docs/ + 根级 AGENTS.md / README。
        const candidates = [];
        for (const p of scoped) {
          const dir = projectDir(base, p);
          for (const rel of p.docs) {
            const full = join(dir, rel);
            if (existsSync(full)) candidates.push(full);
          }
          const docsDir = join(dir, 'docs');
          if (existsSync(docsDir)) {
            for (const f of findFiles(docsDir, /\.md$/i, 2, 40)) candidates.push(f);
          }
          const appDocs = join(dir, 'app', 'docs');
          if (existsSync(appDocs)) {
            for (const f of findFiles(appDocs, /\.md$/i, 2, 40)) candidates.push(f);
          }
        }
        let files = [...new Set(candidates)];
        if (args.file) {
          const needle = String(args.file).toLowerCase();
          files = files.filter((f) => relative(base, f).toLowerCase().includes(needle));
        }

        const hits = [];
        let truncated = false;
        for (const f of files) {
          if (hits.length >= maxHits) {
            truncated = true;
            break;
          }
          let text;
          try {
            text = readFileSync(f, 'utf8');
          } catch {
            continue;
          }
          const lines = text.split(/\r?\n/);
          let section = '';
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const heading = /^(#{1,6})\s+(.*)$/.exec(line);
            if (heading) section = heading[2].trim();
            const lower = line.toLowerCase();
            if (keywords.some((k) => lower.includes(k))) {
              if (hits.length >= maxHits) {
                truncated = true;
                break;
              }
              hits.push({
                file: relative(base, f).replace(/\\/g, '/'),
                line: i + 1,
                section,
                // 400 → 200 字符：文档里很多行是长段落，原值让单次调用可以塞进十几 KB。
                text: clampLine(line.trim(), docsLineChars),
              });
            }
          }
        }
        return Promise.resolve({ hits, scannedFiles: files.length, truncated });
      },
      presentCall: (args) => ({ card: 'generic', title: `检索文档: ${(args.keywords || []).join(' / ')}`, kind: 'read' }),
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

        const { keys, decisions, deviceRequired, reasons, uiChange } = routeRequest(text, {
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
            buildLine: `${p.build.cmd} ${p.build.args.join(' ')}`,
            apk: p.apk ?? null,
            constraints: p.constraints,
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
              small && !smallButNeedsDevice
                ? '完成：mode=small —— 构建成功即结束，不做实机验证'
                : '实机验证：kirara_verify 产出分步测试清单，交用户手动执行',
              ...(uiChange
                ? ['UI 必经：截图 → kirara_verify(purpose=ui-design, screenshots=[...]) → 按 P0/P1 建议改 → 重截复核']
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
        'The only correct way to verify a build here (the API .slnx is broken; desktop needs -p:Platform=x64). Runs in the DSH host, so shell-sandbox and tool-timeout limits do not apply.',
      parameters: {
        project: {
          type: 'string',
          required: true,
          enum: ['desktop', 'api', 'media'],
          description: 'Which sub-project to build.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: { type: 'string', required: true },
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
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `${value.ok ? '✅ 构建成功' : value.timedOut ? '⏱️ 构建超时' : '❌ 构建失败'} — ${value.project}  (${(value.durationMs / 1000).toFixed(1)}s, exit=${value.exitCode ?? 'n/a'})\n` +
              `$ ${value.command}\n` +
              (value.artifact ? `产物: ${value.artifact}\n` : '') +
              (value.errors.length ? `错误:\n${value.errors.map((e) => `  - ${e}`).join('\n')}\n` : '') +
              `日志尾部:\n${value.logTail}`,
          },
        ],
      },
      async execute(args) {
        const base = root();
        const p = findProject(base, args.project);
        const dir = projectDir(base, p);
        if (!existsSync(dir)) {
          return {
            project: p.key,
            command: '',
            ok: false,
            timedOut: false,
            durationMs: 0,
            errors: [`子项目目录不存在: ${dir}`],
            logTail: '',
          };
        }
        const command = `${p.build.cmd} ${p.build.args.join(' ')}`;
        const r = await runProcess(p.build.cmd, p.build.args, dir, timeoutMs);
        const combined = `${r.stdout}\n${r.stderr}`;
        let artifact;
        if (p.apk) {
          const apk = join(dir, p.apk);
          if (existsSync(apk)) artifact = apk;
        }
        // 构建日志会永久留在会话上下文里，所以三层设限：
        //   逐行截断（NuGet/Gradle 单行可上千字符）→ 取尾部 N 行 → 整体字符预算。
        // 实测未设限时单次 kirara_build 曾返回 16.8 KB（≈5000 token），足以把一次
        // 长会话提前推过 compaction 阈值，而 compaction 会让整段前缀缓存作废。
        const clampedTail = tail(combined.trim(), logTail)
          .split(/\r?\n/)
          .map((line) => clampLine(line, buildLineChars))
          .join('\n');
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
          command,
          ok: r.ok,
          ...(r.code == null ? {} : { exitCode: r.code }),
          timedOut: r.timedOut,
          durationMs: r.durationMs,
          errors: extractErrors(combined).map((e) => clampLine(e, buildLineChars)),
          logTail: clampText(clampedTail, buildBudget),
          ...(artifact === undefined ? {} : { artifact }),
        };
      },
      presentCall: (args) => ({ card: 'generic', title: `构建 ${args.project}`, kind: 'execute' }),
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
        // 是否需要「看图」：显式声明，或改动描述里出现界面/交互词族。
        // 后者是兜底 —— 模型忘了传 purpose 时，UI 改动仍然会被截图环节拦一次。
        const uiWork =
          purpose === 'ui-design' ||
          UI_HINTS.test(String(args.summary || '')) ||
          INTERACTION_SIGNALS.test(String(args.summary || ''));
        const base = [
          { action: '构建产物就绪，确认无错误输出', expected: 'kirara_build 返回 ok=true' },
        ];
        // UI 改动：截图 → 视觉复核 → 按建议改 → 重截。这一步不看截图就是盲改样式。
        if (uiWork) {
          base.push({
            action:
              '（UI 必经）截取本次改动涉及的界面：同一窗口尺寸/主题下各状态一张，' +
              '存成 png 后把绝对路径传给 kirara_verify({ purpose: "ui-design", screenshots: [...] })',
            expected: '每张截图都能看清改动区域；看不到的界面明确写「没截图」，不要用「应该没问题」代替',
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
          media: [
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
            ? `安装：产物在 ${p.apk}（相对 ${p.dir}），用 adb install -r 或直接拷到手机安装。`
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
          `\n   注意：${VISION_MODEL} 是当前唯一声明 input:[text,image] 的模型（ecnu-max 仅文本）；` +
          '若某张截图 exists=false，先让用户确认路径，不要跳过，也不要凭文件名猜内容。';
        const visionHead =
          `用 llm 服务以 provider=${VISION_PROVIDER} / model=${VISION_MODEL} 发起一次多模态请求：` +
          '把上面每张截图作为 ImageBlock（attachment）连同下面的提示一起发送 —— 「';
        const uiDesignPrompt =
          `这是 Kirara 的实机界面截图，本轮改动：${args.summary}。` +
          '请按「接下来要改什么代码」来评审，不要只给审美评价。逐条给出：' +
          '① 视觉层级与对齐：哪些元素的间距/字号/圆角/对齐与同屏其他元素不一致 —— 指名控件并给建议数值；' +
          '② 与改动目标的一致性：本次改动在截图里是否真的可见，是否挤压或破坏了原本正常的区域；' +
          '③ 明显缺陷：截断/溢出/对比度不足/缺失图标/缺空态与加载态/深色主题下不可读；' +
          '④ 每条按 P0（必须改）/ P1（应该改）/ P2（可选）标注，并写成「改哪个文件或控件 → 改成什么」。' +
          '最后输出一份可直接执行的修改清单。看不到的内容就说看不到，不要臆测。」';
        const acceptancePrompt =
          `这是 Kirara 改动的实机截图，改动内容：${args.summary}。` +
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
          needScreenshots =
            `本轮是 UI/界面改动（summary 命中界面或交互词族，或 purpose=ui-design），但没有传 screenshots。` +
            `正确流程：先请用户提供实机截图（绝对路径），再用 kirara_verify({ summary, project: '${p.key}', mode: 'full', purpose: 'ui-design', screenshots: [...] }) 复核；` +
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
        const lines = [
          `## 开发总结：${args.feature}`,
          '',
          `- 模式：\`${args.mode}\`（${modeNote}）`,
          '',
          '### 变更',
          ...(args.changes?.length ? args.changes.map((c) => `- ${c}`) : ['- （未记录）']),
          '',
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
          ...(args.risks?.length ? args.risks.map((r) => `- ${r}`) : ['- 无']),
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
        'Decide which docs (docs/*.md, README, AGENTS.md) a change must update, and what to change in each: targets with sections + a checklist. ' +
        'Run it for every feature / bug fix before closing the round — docs drift silently and the next session then reads stale facts. ' +
        'Markdown-only work needs no build.',
      parameters: {
        feature: {
          type: 'string',
          required: true,
          description: 'What changed, in one line (Chinese is fine).',
        },
        changes: {
          type: 'array',
          description: 'Changed files or areas; repo-relative paths let the tool infer the involved ends.',
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
            nextAction: { type: 'string', required: true },
          },
        },
        render: (_args, v) => {
          const body =
            `📄 文档同步 [${v.kind}] —— ` +
            (v.targets.length ? `需更新 ${v.targets.length} 篇\n` : '无需更新正文\n') +
            `判定: ${v.reason}\n` +
            (v.targets.length
              ? '目标:\n' +
                v.targets
                  .map(
                    (t) =>
                      `  - ${t.rel}\n      章节: ${t.sections.join(' / ')}\n      为什么: ${t.why}`,
                  )
                  .join('\n') +
                '\n'
              : '') +
            '清单:\n' +
            v.checklist.map((c) => `  - ${c}`).join('\n') +
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

        const required = kind !== 'chore';
        const { picked, missing, tokens } = required
          ? pickDocTargets(root(), [...keys], feature, changes, docsyncMaxTargets)
          : { picked: [], missing: [], tokens: [] };

        // 章节建议：只读**被选中**的那几篇（最多 docsyncMaxTargets 篇），
        // 不做全库扫描 —— 这个工具的返回值会永久留在上下文里。
        const targets = picked.map((t) => {
          const sections = pickSections(t.abs, tokens);
          return {
            project: t.project,
            dir: findProject(root(), t.project).dir,
            rel: `${findProject(root(), t.project).dir}/${t.rel}`,
            path: t.abs,
            sections: sections.length ? sections : ['（标题未命中关键词：先看目录再定位）'],
            why: t.why,
          };
        });

        const checklist = required
          ? [
              ...targets.map((t) => `${t.rel} → 改「${t.sections.join(' / ')}」`),
              '逐篇核对文档里的命令 / 路径 / 版本号 / 端口 / 端点是否仍与代码一致',
              '有「## 更新记录」的文档补一条本轮条目（日期 + 变更点）',
              '改完用 kirara_docs 按关键词复查，确认新行为已写进文档',
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
          nextAction: targets.length
            ? '逐篇编辑上面的 targets；纯文档改动不需要 kirara_build，改完在 kirara_summary 的 docs 里记一笔。'
            : '本轮无需更新正文文档；按清单收尾即可。',
        });
      },
      presentCall: (args) => ({ card: 'generic', title: `文档同步: ${args.feature}`, kind: 'read' }),
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
