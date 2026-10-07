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

/** 部署侧配置。 */
export const Config = z.object({
  workspaceRoot: z.string().default(''),
  buildTimeoutMs: z.number().default(1200000),
  buildLogTailLines: z.number().default(60),
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
    docs: [
      'docs/服务端后端系统技术栈.md',
      'docs/Kirara Server API 完整文档.md',
      'docs/评论系统API文档.md',
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
    docs: ['app/docs/Kirara Media 安卓版规划文档.md', 'README.md'],
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
 * 判断一句话请求涉及哪些端、是否需要人工拍板、是否必须实机验证。
 * @param {string} text - 用户的自然语言请求。
 * @param {boolean} small - 是否已按「一句话小功能」处理（免实机验证）。
 * @returns {{keys: string[], decisions: object[], deviceRequired: boolean, reasons: string[]}} 涉及的端 + 决策点 + 判定依据。
 */
function routeRequest(text, small) {
  const s = String(text || '');
  const keys = new Set();
  const interactionKeys = new Set();
  for (const sig of ROUTE_SIGNALS) {
    if (!sig.re.test(s)) continue;
    keys.add(sig.key);
    if (sig.ui?.test(s)) interactionKeys.add(sig.key);
  }
  if (keys.size === 0) keys.add('desktop'); // 默认桌面端（项目主体）

  const reasons = [];
  const decisions = [];

  // 界面改动 → 「免实机验证」不成立（构建通过不代表效果正确）。
  // 两类信号任一命中都算：外观/视觉词表，或「用户看得见、能操作」的交互功能词族。
  const uiByHints = UI_HINTS.test(s);
  const uiBySignals = interactionKeys.size > 0;
  const uiByInteraction = !uiByHints && (uiBySignals || INTERACTION_SIGNALS.test(s));
  const uiChange = uiByHints || uiBySignals || uiByInteraction;
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
  return { keys: [...keys], decisions, deviceRequired, reasons };
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
  const logTail = config.buildLogTailLines ?? 60;
  const timeoutMs = config.buildTimeoutMs ?? 1200000;

  // 逐个隔离注册：defineTool() 会**立即**编译参数 schema 并校验视图形状，
  // 任何 DSL 违规都在这里抛出。若让它一口气跑完，一个写错的工具会让 7 个全丢，
  // 而插件整体 apply() 失败还会被宿主当成挂载错误。所以失败者只记日志、不扩散。
  const failed = [];
  const guard = (toolName, factory) => {
    try {
      ctx.tools.register(factory());
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
        'ONE-LINER ENTRY POINT for Kirara development. Give it the user\'s single-sentence request and it returns the whole route: which sub-projects are involved, which docs to read first, the exact per-project build commands, whether live-device verification is required, and any blocking decisions. ' +
        'Prefer this over kirara_route when the user opens with a one-line request — it is the same routing plus the doc-reading and build-command plan baked in. ' +
        'mode=auto (default) picks full/small for you: if a blocking decision is detected the route is treated as full; otherwise small (build-only). ' +
        'If `blocked` is true you MUST call the built-in ask_user_question tool before writing any code.',
      parameters: {
        request: {
          type: 'string',
          required: true,
          description: 'The user\'s one-line feature/fix request, verbatim (Chinese is fine).',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'small', 'full'],
          description:
            'auto (default) = decide from the request; small = 一句话小功能，构建成功即完成；full = 需要实机验证。' +
            ' 注意：请求命中界面/交互关键词时 auto 不会选 small（构建通过 ≠ 效果正确），需显式指定。',
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
            decisions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            steps: { type: 'array', required: true, items: { type: 'string' } },
            nextAction: { type: 'string', required: true },
          },
        },
        render: (_args, v) => [
          {
            type: 'text',
            text:
              `🚀 一句话启动：${v.request}\n` +
              `mode=${v.mode}（${v.modeWhy}）\n` +
              (v.reasons?.length ? `判定依据: ${v.reasons.join('；')}\n` : '') +
              `涉及端: ${v.targets.map((t) => `${t.key}(${t.title})`).join(', ')}\n` +
              `\n先读文档:\n` +
              v.docsToRead.map((d) => `  - ${d.project}: ${d.docs.join(' , ')}`).join('\n') +
              `\n\n构建命令:\n` +
              v.targets.map((t) => `  - ${t.key}: ${t.buildLine}`).join('\n') +
              `\n\n执行步骤:\n` +
              v.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n') +
              (v.blocked
                ? `\n\n⛔ 存在阻塞性决策 —— 必须先 ask_user_question 挂起:\n` +
                  v.decisions.filter((d) => d.blocking).map((d) => `  - ${d.question}`).join('\n')
                : '') +
              `\n\n▶ ${v.nextAction}`,
          },
        ],
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
        // 先按 full 探一遍：只要出现阻塞项，或需要看实机效果，就不能当小功能草率放过。
        const probe = routeRequest(request, false);
        const blocked = probe.decisions.some((d) => d.blocking);
        const mode = wantAuto ? (blocked || probe.deviceRequired ? 'full' : 'small') : args.mode;
        const small = mode === 'small';

        // small 模式下重新取一次决策（避免把 media 的实机问询算成决策噪声）
        const final = small ? routeRequest(request, true) : probe;
        const { keys, decisions } = final;

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
        const docsToRead = keys
          .map((k) => findProject(root(), k))
          .map((p) => ({
            project: p.key,
            dir: p.dir,
            docs: (p.docs ?? []).slice(0, 4),
          }));

        const steps = [
          `解读：用 kirara_docs 按关键词检索上面列出的文档，确认现状与影响面（不要整篇读）。`,
          blocked
            ? '定路线：存在阻塞性决策 → 先 ask_user_question 挂起，拿到答复再动手。'
            : '定路线：无阻塞项 → 直接进入开发。',
          '开发：按各端约束改代码（完整约束用 kirara_profile 取，别读 AGENTS.md）。',
          `构建验证：逐端调用 kirara_build（${keys.join(' → ')}），未通过就修到通过。`,
          small
            ? '完成：mode=small —— 构建成功即结束，不需要实机验证。'
            : '实机验证：调用 kirara_verify 产出分步测试清单交用户执行；用户截图后可传 screenshots 走 ecnu-plus 复核。',
          '总结（仅本轮确有代码变更时）：调用 kirara_summary 汇总变更/构建结论/验证状态/遗留风险；纯问答或零变更轮次可跳过。',
        ];

        return Promise.resolve({
          request,
          mode,
          modeWhy: wantAuto
            ? blocked
              ? '自动判定：检测到阻塞性决策，按 full 处理（需实机验证 + 先拍板）。'
              : probe.deviceRequired
                ? '自动判定：请求涉及用户可见效果，不能按 small 处理（构建通过 ≠ 效果正确）。'
                : '自动判定：无阻塞项、未命中界面/交互信号，按 small 处理（构建成功即完成）。' +
                  '⚠️ 自动判定可能漏判：若本次改动实际有用户可见效果，显式传 mode=full 覆盖。'
            : `显式指定 mode=${mode}（${small ? '构建成功即完成' : '需实机验证'}）。`,
          reasons: final.reasons,
          targets,
          docsToRead,
          blocked,
          decisions,
          steps,
          nextAction: blocked
            ? 'STOP：调用 ask_user_question 挂起，禁止先写代码。'
            : `开始改代码；改完用 kirara_build 验证 ${keys.join('/')}。`,
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
        'Return the Kirara multi-repo project profile: the three sub-projects, their exact build/publish commands, key constraints, and the process-cleanup safety rules. ' +
        'Call this instead of reading the very large AGENTS.md / copilot-instructions.md files (they are up to 153 KB each and crowd out the context window). ' +
        'ALWAYS call this before building anything for this project, because the API solution file is broken and the desktop project requires a platform flag.',
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
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Kirara profile @ ${value.workspaceRoot}\n` +
              value.projects
                .map(
                  (p) =>
                    `- [${p.key}] ${p.title}\n    build: ${p.buildLine}\n    docs:  ${(p.docs || []).join(', ')}`,
                )
                .join('\n') +
              (value.missing.length ? `\n缺失目录: ${value.missing.join(', ')}` : ''),
          },
        ],
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
            '2. route — 按用户自然语言定路线；小功能 mode=small（免实机），大功能 mode=full',
            '3. 若需要用户拍板：不要猜，用内置 ask_user_question 挂起提问',
            '4. develop — 按约束改代码',
            '5. build — kirara_build 构建验证；mode=small 构建成功即结束',
            '6. verify — kirara_verify 产出分步测试清单交用户手动执行',
            '7. summary — kirara_summary 汇总变更/构建/清单/遗留风险',
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
        'Search the Kirara technical documents (client/server/Android) for a keyword and return matching lines with file path and line number, plus the section heading they sit under. ' +
        'Use this for progressive disclosure instead of reading whole documents — some are 200 KB+. ' +
        'Give several keywords to get a joined picture, or pass file to read one document around a line.',
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
        maxHits: { type: 'integer', description: 'Max matching lines to return. Defaults to 40.' },
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
        render: (_args, value) => [
          {
            type: 'text',
            text: value.hits.length
              ? value.hits
                  .map((h) => `${h.file}:${h.line}  [${h.section || '-'}]\n    ${h.text}`)
                  .join('\n')
              : `无命中（扫描 ${value.scannedFiles} 个文件）`,
          },
        ],
      },
      execute(args) {
        const base = root();
        const keywords = (args.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
        const maxHits = args.maxHits ?? 40;
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
                text: line.trim().slice(0, 400),
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
        'Turn a natural-language feature request into a development route for the Kirara project: which sub-projects are involved, the exact build command to verify with, whether live-device verification is required, and any decisions the human must make. ' +
        'Use mode=small for one-line small features (build-only, no device verification) and mode=full for features needing real-device verification. ' +
        'It never guesses on the human\'s behalf: when a decision is returned in `decisions`, you MUST suspend by calling the built-in ask_user_question tool before writing any code.',
      parameters: {
        request: {
          type: 'string',
          required: true,
          description: 'The feature/fix request in the user\'s own words (Chinese is fine).',
        },
        mode: {
          type: 'string',
          required: true,
          enum: ['small', 'full'],
          description: 'small = 一句话小功能，构建成功即完成；full = 需要实机验证。',
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
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `mode=${value.mode}  实机验证=${value.requiresDeviceVerification ? '需要' : '不需要'}\n` +
              `计划:\n${value.plan.map((s) => `  - ${s}`).join('\n')}\n` +
              `目标端: ${value.targets.map((t) => t.key).join(', ') || '(未识别)'}\n` +
              (value.decisions.length
                ? `⚠️ 需要用户拍板 ${value.decisions.length} 项 —— 必须先 ask_user_question 挂起:\n` +
                  value.decisions.map((d) => `  - ${d.question}`).join('\n')
                : '无需拍板，可直接开发') +
              `\n下一步: ${value.nextStep}`,
          },
        ],
      },
      execute(args) {
        const text = String(args.request || '');
        const small = args.mode === 'small';

        const { keys, decisions, deviceRequired, reasons } = routeRequest(text, small);
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

        const plan = [
          `解读：用 kirara_docs 检索相关文档，确认现状与影响面（端：${keys.join(', ')}）`,
          decisions.length ? '定路线：先 ask_user_question 挂起拍板，得到答复后再继续' : '定路线：无需拍板，直接进入开发',
          '开发：按各端约束改代码（约束见 kirara_profile）',
          `构建验证：逐端执行 kirara_build（${targets.map((t) => t.key).join(', ')}）`,
          small && !smallButNeedsDevice
            ? '完成：mode=small —— 构建成功即结束，不做实机验证'
            : '实机验证：kirara_verify 产出分步测试清单，交用户手动执行',
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
          requiresDeviceVerification: deviceRequired || !small,
          nextStep: decisions.some((d) => d.blocking)
            ? 'STOP：存在阻塞性决策，必须先调用 ask_user_question 挂起，禁止先写代码。'
            : '可以开始开发；改完调用 kirara_build 验证。',
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
        'Run the real build for one Kirara sub-project and return a structured verdict (ok / exit code / duration / extracted errors / log tail). ' +
        'The build runs in the DSH host process, so it is not subject to shell-tool sandbox stdio limits and does not consume a tool call timeout. ' +
        'This is the ONLY correct way to verify a build here: it uses the per-project command that is known to work (the API .slnx is broken and the desktop project needs -p:Platform=x64).',
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
          errors: extractErrors(combined),
          logTail: tail(combined.trim(), logTail),
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
        'Produce a step-by-step real-device acceptance checklist (steps + expected result) for a Kirara change, for the human to run themselves. ' +
        'This project does NOT use unit tests: verification is a build plus a manual device checklist, so always use this tool instead of proposing tests. ' +
        'Use mode=small to explicitly skip device verification (build-only).',
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
          enum: ['small', 'full'],
          description: 'small = 免实机验证（只构建）；full = 需要实机验证清单。',
        },
        screenshots: {
          type: 'array',
          description:
            'Optional: absolute paths of device screenshots the human already captured. ' +
            'When given, the result includes a ready-to-run screenshot-review protocol that feeds them to the vision model ' +
            `(${VISION_PROVIDER}/${VISION_MODEL}, declared input: text+image).`,
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
            screenshotReview: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.skipped
              ? `模式 small：跳过实机验证。${value.reason || ''}`
              : `实机验证清单（共 ${value.steps.length} 步）:\n` +
                (value.howToInstall ? `${value.howToInstall}\n` : '') +
                value.steps
                  .map((s, i) => `${i + 1}. ${s.action}\n   期望: ${s.expected}`)
                  .join('\n') +
                (value.screenshotReview
                  ? `\n\n📷 截图复核协议（${value.screenshotReview.provider}/${value.screenshotReview.model}）:\n` +
                    `   待复核 ${value.screenshotReview.screenshots.length} 张：\n` +
                    value.screenshotReview.screenshots
                      .map((s) => `     - ${s.path}${s.exists ? '' : '  ⚠️ 文件不存在'}`)
                      .join('\n') +
                    `\n   下一步：${value.screenshotReview.instruction}`
                  : ''),
          },
        ],
      },
      execute(args) {
        if (args.mode === 'small') {
          return Promise.resolve({
            skipped: true,
            reason: '小功能按约定免实机验证，仅需构建成功。如需真机确认，用 mode=full 重新调用。',
            steps: [],
          });
        }
        const p = findProject(root(), args.project);
        const base = [
          { action: '构建产物就绪，确认无错误输出', expected: 'kirara_build 返回 ok=true' },
        ];
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
        const howToInstall =
          p.key === 'media'
            ? `安装：产物在 ${p.apk}（相对 ${p.dir}），用 adb install -r 或直接拷到手机安装。`
            : p.key === 'desktop'
              ? `运行：${p.dir} 下 Debug 构建产物（Unpackaged）。注意 app.manifest 要求管理员权限。`
              : `运行：cd ${p.dir} && ${p.run.cmd} ${p.run.args.join(' ')}`;

        // 截图复核：只产出协议，不自己调模型。
        // 插件跑在宿主进程里，拿不到会话级 llm 服务；由模型按协议发起真正的图像推理。
        let screenshotReview;
        const shots = args.screenshots || [];
        if (shots.length) {
          screenshotReview = {
            provider: VISION_PROVIDER,
            model: VISION_MODEL,
            task: args.summary,
            screenshots: shots.map((s) => {
              const abs = resolve(String(s));
              return { path: abs, exists: existsSync(abs) };
            }),
            instruction:
              `用 llm 服务以 provider=${VISION_PROVIDER} / model=${VISION_MODEL} 发起一次多模态请求：` +
              '把上面每张截图作为 ImageBlock（attachment）连同下面的提示一起发送 —— ' +
              `「这是 Kirara 改动的实机截图，改动内容：${args.summary}。` +
              '请逐张判断：① 界面是否正常渲染（无白屏/错位/乱码/占位图）；' +
              '② 是否可见本次改动对应的 UI；③ 有无明显异常（错误弹窗、缺失图标、对比度问题）。' +
              '逐条给出「通过 / 不通过 + 依据」，最后给一句总体结论。不要臆测看不到的内容。」' +
              `\n   注意：${VISION_MODEL} 是当前唯一声明 input:[text,image] 的模型（ecnu-max 仅文本）；` +
              '若某张截图 exists=false，先让用户确认路径，不要跳过。',
          };
        }
        // ⚠️ 无截图时**不能**写成 `screenshotReview`（即 undefined）：宿主对返回值做 lossless
        //    快照校验，显式的 undefined 会让整次调用以
        //    `tool "kirara_verify" returned invalid output` 被拒收 —— 与 §4.2 artifact 同源。
        //    条件展开确保该键在无截图时**根本不出现**。
        return Promise.resolve({
          skipped: false,
          steps,
          howToInstall,
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
        'Compose the closing summary of one Kirara development round: change list, build verdicts, device-test checklist status, and remaining risks. ' +
        'Call it as the last step of a round that actually CHANGED code, so the human gets one consistent report instead of scattered tool output. ' +
        'Skip it for rounds with no changes (pure Q&A, planning-only, or a route that was abandoned) — a summary of nothing is noise.',
      parameters: {
        feature: { type: 'string', required: true, description: 'What was developed.' },
        mode: { type: 'string', required: true, enum: ['small', 'full'] },
        changes: {
          type: 'array',
          required: true,
          description: 'Changed files or areas.',
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
        render: (_args, value) => [{ type: 'text', text: value.markdown }],
      },
      execute(args) {
        const full = args.mode === 'full';
        const lines = [
          `## 开发总结：${args.feature}`,
          '',
          `- 模式：\`${args.mode}\`（${full ? '含实机验证' : '小功能，仅构建验证'}）`,
          '',
          '### 变更',
          ...(args.changes?.length ? args.changes.map((c) => `- ${c}`) : ['- （未记录）']),
          '',
          '### 构建验证',
          ...(args.builds?.length ? args.builds.map((b) => `- ${b}`) : ['- （未记录）']),
          '',
          '### 实机验证',
          full
            ? '- 已产出分步测试清单，待你手动执行（见 kirara_verify 输出）'
            : '- 按约定跳过：小功能构建成功即完成',
          '',
          '### 遗留风险 / 后续',
          ...(args.risks?.length ? args.risks.map((r) => `- ${r}`) : ['- 无']),
          '',
          '> 进程清理：本项目禁止批量杀 `dotnet.exe`、禁止 `dotnet build-server shutdown`；',
          '> 只停自己启动的进程；Gradle 用 `gradlew --stop`。',
        ];
        return Promise.resolve({
          markdown: lines.join('\n'),
          deviceVerificationRequired: full,
        });
      },
      presentCall: (args) => ({ card: 'generic', title: `总结：${args.feature}`, kind: 'other' }),
    }),
  );

  if (failed.length > 0) {
    console.error(
      `[kirara-dev] ${failed.length}/7 个工具注册失败：${failed.join(', ')} —— ` +
        '其余工具仍可用；修复定义后跑 node scripts/deploy.mjs 重新部署并重启 DSH。',
    );
  }
}
