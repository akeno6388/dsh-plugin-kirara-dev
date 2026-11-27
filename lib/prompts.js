/**
 * 外部强模型交接包的**文字层**。
 *
 * 为什么单独一个模块：
 *   交接包（brief / prompt / 回执契约）是**纯文本**，而它的读者有两类 ——
 *   DSH 侧的模型（要判断「交给谁、交什么」）和外部实现者（只有这份文件，没有任何上下文）。
 *   两者看到的都必须是同一份措辞，所以这里只做字符串拼接：
 *   **无 IO、不依赖 cordis、不 import 任何东西**，可以直接单测（scripts/handoff-test.mjs）。
 *
 * 分工（本模块所有文案都建立在这个前提上）：
 *   阶段 1 / 4 —— DSH 侧：需求解读、路由判定、检索文档、产出交接包、收回执、文档同步、发布、总结
 *   阶段 2 / 3 —— 外部实现者：改代码、跑构建、用 MCP 实时看界面并自验收
 *   所以交接包里**不能**出现「你去更新文档」「你去发版」这类越界要求，也不能替外部实现者
 *   写死具体 MCP 工具名（那取决于那台机器上装了什么，写死等于教它说谎）。
 *
 * @module @kirara/dsh-plugin-kirara-dev/prompts
 */

/** 外部实现者的角色与边界（中文，原样出现在 brief 与 prompt 里）。 */
export const EXECUTOR_ROLE = [
  '你是本轮 Kirara 开发的**外部实现者**（带 MCP 的编码智能体）。',
  '你的交付物是「改好的代码 + 真跑过的构建 + 看过的界面 + 一份结构化回执」，不是计划、不是解释、不是文档。',
  '分工是固定的：DSH 侧负责需求解读、路由、检索文档、文档同步与发版；你负责改代码、跑构建、',
  '用 MCP 实时看界面并自验收。所以**不要**改技术文档、不要发版或改版本号、不要改 DSH 插件本体、不要替用户拍板。',
].join('\n');

/**
 * 回执 JSON 契约（brief 第 9 节与 prompt.md 引用同一份，避免两处措辞漂移）。
 * 校验规则在 impl.js 的 closeReport() 里：缺 status / summary / changed 一律拒收。
 */
export const REPORT_SPEC = [
  '```json',
  '{',
  '  "runId": "<runId>",',
  '  "status": "done | partial | blocked",',
  '  "summary": "一句话说清做了什么（必填）",',
  '  "changed": [{ "file": "Kirara_Media/app/src/main/java/.../SettingsScreen.kt", "why": "为什么改" }],',
  '  "commands": [{ "cmd": "gradlew assembleDebug", "exit": 0, "note": "48s" }],',
  '  "screenshots": [{ "path": "shots/shot-01.png", "state": "设置页-深色", "note": "改后" }],',
  '  "verification": {',
  '    "build": "ok | failed | skipped",',
  '    "uiLoop": "closed | open | n/a",',
  '    "acceptance": [{ "item": "验收项", "result": "pass | fail", "evidence": "证据" }]',
  '  },',
  '  "docsHint": ["SettingsScreen 的默认值变了，需更新 11.2 小节"],',
  '  "openIssues": [],',
  '  "blockedBy": null',
  '}',
  '```',
  '规则（DSH 侧按这些规则校验，不合格整份回执被拒、不写 report.json）：',
  '- `status` / `summary` / `changed` 三项必填，缺任意一项都会被拒收。',
  '- `changed[].file` 写**仓库相对路径**，原样保留给 DSH 侧的文档同步（kirara_docsync）用。',
  '- `screenshots[].path` 相对本目录的 `shots/` 解析，文件必须**真实存在**；不存在的会被点名列出。',
  '- 整段 JSON 或包在 ```json 围栏里都可以。',
  '- **没跑过的构建不许写 ok，没看过的界面不许写 pass** —— 回执是下一阶段的输入，不是自评表。',
].join('\n');

/** DSH 侧收到回执后的固定指引（拼进 close 的 nextStep）。 */
export const CLOSE_PROMPT =
  '先 kirara_docsync({ feature, changes }) 定该同步哪几篇、每篇改哪些章节，再按清单写 docs/，最后 kirara_summary 收尾；' +
  '回执里的 docsHint / openIssues 要一并带上。';

/**
 * 第 8 节「MCP 用法」的静态文案。
 *
 * 刻意**不写具体工具名**：那台机器上装了什么 MCP 是运行时事实，写死等于教外部实现者
 * 去调用一个可能不存在的工具（然后它会在回执里编造截图）。所以这里只描述能力与兜底路径，
 * 并在末尾统一给一条「没有就明说，不要假装」。
 */
const MCP_USAGE = {
  desktop: [
    '桌面端（WinUI 3）：优先用桌面自动化 MCP（Windows UI Automation / Avalonia 类工具的「截图 / 点按 / 控件树」三件套）；',
    '  没有可用的桌面 MCP 时，用 pwsh 启动应用 + 系统截图，并在回执里写明「无 MCP，手工截图」。',
  ],
  api: [
    '后端没有界面：不需要截图，也不要为了「有截图」去截终端。',
    '取证用真实请求与日志：curl / psql / 应用日志，把命令与关键输出写进 `commands[]` 与 `verification.acceptance[].evidence`。',
  ],
  mediaAndroid: [
    'Android：用 adb 截图 / 点按（或设备控制 MCP，若那台机器装了）；',
    '  截图命令例如 `adb -s <serial> exec-out screencap -p > shots/shot-01.png`（相对本目录写文件）。',
  ],
  mediaIos: [
    'iOS：用 Xcode MCP（截图 / 点按 / UI 树）或 simctl 兜底（`xcrun simctl io <udid> screenshot shots/shot-01.png`）。',
    '  模拟器 GUI 是 DeviceHub；simctl 不能打字也不能点按 —— 需要手动输入的位置在回执里写明「需人肉复核」。',
  ],
  browser: [
    '浏览器（若有 Playwright 类 MCP）：本机前端页面 / WKWebView 宿主页可以先在浏览器里复现与截图。',
  ],
  honesty: [
    '**不要假装**：这台机器上没有对应 MCP 或设备时，就在回执里写明「不可用」并给兜底取证（命令行截图 / 日志），',
    '  不要写一个没跑过的工具名，也不要贴不存在的截图路径。',
  ],
};

/** 该端要显示哪几条 MCP 说明。 */
function mcpLines(target, ctx) {
  const lines = [];
  if (target.key === 'desktop') lines.push(...MCP_USAGE.desktop);
  else if (target.key === 'api') lines.push(...MCP_USAGE.api);
  else if (target.key === 'media') {
    lines.push(...(ctx.iosFocus ? MCP_USAGE.mediaIos : MCP_USAGE.mediaAndroid));
    // media 的 iOS 侧本质是 WKWebView 宿主页，浏览器那条对它同样成立。
    if (ctx.iosFocus) lines.push(...MCP_USAGE.browser);
  }
  if (target.key === 'api' && ctx.uiChange) lines.push(...MCP_USAGE.browser);
  return lines;
}

function listOf(items, bullet = '- ') {
  return items.length ? items.map((s) => `${bullet}${s}`).join('\n') : '- （无）';
}

/** 需求关键词命中 -> 挑最相关的 N 条 pitfalls（纯函数，稳定排序，便于单测）。 */
function pickPitfalls(pitfalls, request, max) {
  const text = String(request || '');
  const scored = pitfalls.map((p, i) => {
    let score = 0;
    for (const token of text.split(/[\s,，、。；;：:（）()\[\]【】/\\|+]+/)) {
      if (token.length >= 2 && p.includes(token)) score += 1;
    }
    // iOS 里「静默失败」的四条更值得先看：编译期抓不到、日志里也不显眼。
    if (/JAVA_HOME|doInitKoinIos|simctl|DeviceHub|setCookie/.test(p)) score += 1;
    return { p, i, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, max).map((s) => s.p);
}

/**
 * 有界面的端。uiChange 会把「交互信号」（@ 提醒 / 通知 / 点赞）也算进来，
 * 但后端没有界面 —— 对 api 说「去截图」是错的，所以文案要按端分叉。
 */
const UI_PROJECTS = new Set(['media', 'desktop']);

/** @param {Array<{key:string}>} targets @returns {string[]} */
function uiTargetKeys(targets) {
  return (Array.isArray(targets) ? targets : [])
    .filter((t) => t && UI_PROJECTS.has(t.key))
    .map((t) => t.key);
}

/** 验收标准里的构建行；纯文档变更不给构建。 */
function acceptanceBody(ctx) {
  const out = [];
  if (ctx.docsOnly) {
    out.push('本轮是**纯文档变更**：不构建、不截图、不跑设备。');
    out.push('- 只编辑 `.md`；`changed[]` 里列出的必须是真的改过的文档路径。');
    out.push('- 不要顺手改代码或依赖 —— 那会把「免构建」的前提破坏掉。');
    return out;
  }
  out.push('构建（必须真跑，转述无效）：');
  for (const t of ctx.targets) {
    out.push(`- ${t.key}: 在 \`${t.dir}\` 内执行 \`${t.command || t.buildLine}\` → 期望 **exit 0**`);
    if (ctx.iosFocus && t.klibLine) {
      out.push(`  - 本机不是 macOS 时，iOS 侧只到 klib 门禁：\`${t.klibLine}\`（不证明能链接、不证明界面）`);
    }
  }
  const uiKeys = uiTargetKeys(ctx.targets);
  if (ctx.uiChange && uiKeys.length) {
    out.push(
      '',
      '视觉环（本次命中界面/交互信号，必做）：',
      '- 至少截 3 个状态：**改动后的目标界面**、**改动前的同类界面（或默认态）**、**一组对比态**（浅色/深色、空列表/有数据、展开/收起任选）。',
      '- 截图写进本目录的 `shots/`，文件名 `shot-01.png`、`shot-02.png`…；每张在 `screenshots[]` 里写 `state`（哪个页面、哪个主题/状态）。',
      '- 看完再改、改完再看；**没看过界面不许写 done**。收敛后的那一次截图才是验收证据。',
    );
  } else if (ctx.uiChange) {
    out.push(
      '',
      '行为验收要点（本次是交互类改动，但登记端没有界面）：',
      '- 不要产出截图，也不要声称「看过界面」；用请求/响应、日志、数据库或可观察状态作为证据。',
    );
  }
  out.push(
    '',
    '行为验收（逐条给 `pass` / `fail` + 证据）：',
    '1. 需求原文里描述的行为，在真机或模拟器上成立（不是「代码看起来对」）。',
    '2. 相邻功能没被破坏：至少给一条回归项（同页面其它开关、同一接口的其它字段、同一列表的空态）。',
    '- **不许把「构建通过」当验收**：构建只证明能编译，不证明效果对。',
  );
  if (ctx.mode === 'small') {
    out.push('- 本轮 mode=small：构建成功即可收工；若你在过程中发现有用户可见效果，回执里 `status=partial` 并说明需要 DSH 侧补实机清单。');
  }
  if (ctx.iosFocus) {
    out.push(
      '- iOS：Windows 上只能编 klib（`:shared:compileKotlinIos*`），链接 / 出包 / 模拟器截图必须在 macOS 上做；',
      '  平台不符时在回执里写明「本机只能到 klib 门禁」，不要声称跑过模拟器。',
    );
  }
  return out;
}

/**
 * 拼 `brief.md` 的九节正文。
 * @param {object} ctx 见 impl.js 的 buildHandoffContext()；本函数只读不写。
 * @returns {string}
 */
export function briefMarkdown(ctx) {
  const targets = Array.isArray(ctx.targets) ? ctx.targets : [];
  const reasons = Array.isArray(ctx.reasons) ? ctx.reasons : [];
  const safety = Array.isArray(ctx.safety) ? ctx.safety : [];
  const docHits = Array.isArray(ctx.docHits) ? ctx.docHits : [];
  const decisions = Array.isArray(ctx.decisions) ? ctx.decisions : [];

  const blocks = [];
  blocks.push(`# 交接包 ${ctx.runId} — ${ctx.mode}${ctx.uiChange ? ' · 界面/交互改动' : ''}`);
  blocks.push(
    `这是 DSH 与**外部实现者**之间的交接目录。你要做的是：读本文件 → 改代码 → 跑构建 → 用 MCP 看界面 → 按第 9 节回执。`,
  );

  // ── 1. 任务卡 ──────────────────────────────────────────────────────────────
  blocks.push(
    [
      '## 1. 任务卡',
      `- runId: \`${ctx.runId}\``,
      `- 生成时间: ${ctx.generatedAt}（本机本地时间）`,
      `- 工作区根: \`${ctx.workspaceRoot}\``,
      `- mode: **${ctx.mode}** —— ${ctx.modeWhy || ''}`,
      `- 需求原文: 「${ctx.request}」`,
      `- 判定依据: ${reasons.length ? reasons.join('；') : '（无额外信号，按显式 mode 执行）'}`,
      ...(ctx.blocked && decisions.length
        ? [`- ⚠️ 路由阶段检测到需人拍板的点（DSH 侧负责追问，你**不要**自己决定）: ${decisions.map((d) => d.question).join(' / ')}`]
        : []),
    ].join('\n'),
  );

  // ── 2. 你的边界 ────────────────────────────────────────────────────────────
  blocks.push(
    [
      '## 2. 你的边界',
      EXECUTOR_ROLE,
      '',
      '**可做**：改本仓库代码、跑构建与测试命令、截图、用本机的 MCP 实时看界面、自验收。',
      '',
      '**不可做**：',
      '- 改 `docs/` 下的技术文档 —— 文档同步由 DSH 侧 kirara_docsync 决定，你只在回执 `docsHint` 里说明「哪里需要同步」。',
      '- 发版 / 打包上传 / 改版本号 / 动 README 门禁。',
      '- 改 DSH 插件本体（`dsh-plugin-kirara-dev`）或其它与本需求无关的仓库。',
      '- 借机做需求之外的重构、依赖升级、全仓库格式化。',
      '',
      '**进程清理红线（任何构建路径都必须遵守）**：',
      listOf(safety),
    ].join('\n'),
  );

  // ── 3. 涉及端 ──────────────────────────────────────────────────────────────
  const targetBlocks = [`## 3. 涉及端`];
  for (const t of targets) {
    targetBlocks.push(
      [
        `### ${t.key} — ${t.title}`,
        `- 仓库目录: \`${t.dir}\`（在工作区根下）`,
        `- 技术栈: ${t.stack}`,
        ...(t.tfm ? [`- 目标框架: ${t.tfm}`] : []),
        `- 构建命令: \`${t.command || t.buildLine}\``,
        // buildLine 里带着 iOS 那半边的说明（Windows 只能编 klib / 链接必须在 macOS）。
        // 命令本身已经在上一行，所以这里只补说明部分，避免同一句话重复两遍。
        ...(t.buildLine && t.buildLine !== t.command
          ? [
              `- 平台说明: ${
                t.buildLine.startsWith(t.command)
                  ? t.buildLine.slice(t.command.length).replace(/^\s*/, '')
                  : t.buildLine
              }`,
            ]
          : []),
        ...(t.artifact ? [`- 产物: \`${t.artifact}\``] : []),
        ...(t.ios ? [`- iOS 版本锁: ${t.ios.versionLock}`] : []),
        ...(t.ios ? [`- iOS 截图落点: \`${t.ios.evidenceDir}\`（全量自检脚本的产物；本轮的截图请写进 shots/）`] : []),
      ].join('\n'),
    );
  }
  if (!targets.length) targetBlocks.push('（未识别出涉及端：先按工作区根下的三个仓库自行判断，并在回执里写明你改了哪个仓库。）');
  blocks.push(targetBlocks.join('\n\n'));

  // ── 4. 必读事实 ────────────────────────────────────────────────────────────
  const factBlocks = ['## 4. 必读事实'];
  for (const t of targets) {
    factBlocks.push(`### ${t.key} 硬约束（全量）\n${listOf(t.constraints || [])}`);
    if (t.ios && t.ios.pitfalls?.length && ctx.iosFocus) {
      const picked = pickPitfalls(t.ios.pitfalls, ctx.request, 3);
      factBlocks.push(
        `### ${t.key} · iOS 静默失败坑（本轮挑 3 条，完整清单见 \`${t.ios.docsHint || 'app/docs/Kirara Media iOS P0 Mac 执行清单.md'}\`）\n${listOf(picked)}`,
      );
    }
  }
  if (factBlocks.length === 1) factBlocks.push('（没有命中的端级约束；先读第 5 节的文档再动手。）');
  blocks.push(factBlocks.join('\n\n'));

  // ── 5. 代码定位线索 ────────────────────────────────────────────────────────
  const docBlocks = ['## 5. 代码定位线索（先读这几篇，不要整篇读大文档）'];
  for (const t of targets) {
    docBlocks.push(`- ${t.key}（\`${t.dir}\`）: ${(t.docs || []).length ? t.docs.map((d) => `\`${d}\``).join(', ') : '（无登记的文档，先用仓库内 README / 目录结构定位）'}`);
  }
  if (targets.length === 0) docBlocks.push('- （同第 3 节：先自行判断）');
  // 源文件线索：命中章的 frontmatter.files 是「这篇文档在讲哪些源文件」的稳定事实。
  // 由 impl 侧展开并过滤（只保留 existsSync 为真的条目），这里只负责排版 ——
  // 本模块不做 IO，所以**不要**在这里加 existsSync 或读文件。
  const codeHints = Array.isArray(ctx.codeHints) ? ctx.codeHints : [];
  if (codeHints.length) {
    docBlocks.push('- 源码线索（第 6 节命中章的 frontmatter.files，已按仓库根校验存在）:');
    for (const h of codeHints) {
      docBlocks.push(`  - ${h.path}${h.from ? `（来自 ${h.from} 章的 files）` : '（来自章 frontmatter 的 files）'}`);
    }
  }
  docBlocks.push('- 单篇技术文档最大 258 KB：按小节读，不要整篇塞进上下文。');
  blocks.push(docBlocks.join('\n'));

  // ── 6. 文档片段 ────────────────────────────────────────────────────────────
  const hitLines = ['## 6. 文档片段（按需求关键词检索出的命中，格式 文件:行号）'];
  if (docHits.length) {
    // h.file 已经是**工作区相对路径**（含仓库目录名），所以不再拼 project，
    // 否则会出现 `media/Kirara_Media/...` 这种重复前缀。
    for (const h of docHits) hitLines.push(`- \`${h.file}\`:${h.line} —— ${h.text}`);
  } else {
    hitLines.push('- （本轮没有关键词命中：按第 5 节的文档自己检索，**不要猜路径**，也不要编造引用。）');
  }
  blocks.push(hitLines.join('\n'));

  // ── 7. 验收标准 ────────────────────────────────────────────────────────────
  blocks.push(['## 7. 验收标准（自己跑，别转述）', ...acceptanceBody(ctx)].join('\n'));

  // ── 8. MCP 用法 ────────────────────────────────────────────────────────────
  const mcp = ['## 8. MCP 用法（按端给；没有就写「不可用」，不要假装）'];
  const seen = new Set();
  if (ctx.docsOnly) {
    // 纯文档变更：没有界面可看，也不需要设备。给一串 adb/simctl 只会让外部模型
    // 误以为「要截图才算完成」，顺手把一份 md 改动做成一次实机验证。
    mcp.push('- 本轮是**纯文档变更**：不需要 MCP、不需要截图、不需要设备。');
  } else {
    for (const t of targets) {
      const lines = mcpLines(t, ctx);
      if (!lines.length) continue;
      const sig = lines.join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      mcp.push(`### ${t.key}`);
      mcp.push(...lines.map((l) => (l.startsWith('  ') ? l : `- ${l}`)));
    }
    if (mcp.length === 1) mcp.push('- （本轮没有需要界面的端：不需要 MCP，也不要为了「用上 MCP」去截图。）');
  }
  mcp.push(...MCP_USAGE.honesty.map((l) => (l.startsWith('  ') ? l : `- ${l}`)));
  blocks.push(mcp.join('\n'));

  // ── 9. 回执格式 ────────────────────────────────────────────────────────────
  blocks.push(
    [
      '## 9. 回执格式',
      `回执交给 DSH 侧（\`kirara_handoff({ action: 'close', runId: '${ctx.runId}', report })\`），DSH 会校验后落成 \`report.json\`：`,
      REPORT_SPEC,
      '',
      `截图写到本目录的 \`shots/\`（相对路径写进 \`screenshots[].path\`，例如 \`shots/shot-01.png\`）。`,
    ].join('\n'),
  );

  return `${blocks.join('\n\n')}\n`;
}

/**
 * 拼 `prompt.md` —— 可直接粘贴给外部实现者的那段话（约 800–1200 字）。
 * 它不重复 brief 的九节，只负责「从哪开始、边界是什么、怎么回执」。
 *
 * 两种投递形态（`ctx.executor`）：
 *   - `file`（默认）：外部模型**能读本地文件**，所以只给交接目录路径，正文在 brief.md；
 *   - `chat`：外部模型在**纯聊天**里（读不到任何本地文件），brief 正文会被整段嵌进返回值，
 *     所以这里改成「以下是完整 brief，直接读」，并明确「被截断就向用户要全文」。
 *
 * @param {object} ctx 同 briefMarkdown（另读 ctx.executor）。
 * @returns {string}
 */
export function handoffPrompt(ctx) {
  const targets = Array.isArray(ctx.targets) ? ctx.targets : [];
  const names = targets.map((t) => `${t.key}（${t.dir}）`).join('、') || '（见 brief）';
  const chat = ctx.executor === 'chat';
  const uiSuffix = (c) => {
    if (!c.uiChange) return '';
    return uiTargetKeys(c.targets).length
      ? '；命中界面/交互信号：视觉环必做（截图存 shots/）'
      : '；命中交互信号：本端没有界面，做行为验收，不要声称看过截图';
  };
  return [
    `【Kirara 外部实现交接 · ${ctx.runId}】`,
    '',
    // chat 与 file 的分岔只在这两行：读不到文件的模型最怕的是「以为还有一份文件没读到」。
    ...(chat
      ? [
          '以下是**完整 brief 正文**（你读不到本机文件，所以整份内容已经贴在这里）——直接读，不要去找文件。',
          `如内容被截断，请向用户索取 brief.md 全文（本机路径: ${ctx.briefPath}）。`,
          `交接目录（有文件系统访问时才用得到）: ${ctx.dir}`,
        ]
      : [
          `交接目录: ${ctx.dir}`,
          `必读: ${ctx.briefPath}`,
          '先完整读这份 brief.md（任务卡 / 边界 / 涉及端 / 必读事实 / 文档线索 / 文档片段 / 验收标准 / MCP 用法 / 回执格式），再动手。',
        ]),
    '',
    `需求: 「${ctx.request}」`,
    `涉及端: ${names}；mode=${ctx.mode}${uiSuffix(ctx)}。`,
    '',
    '你的身份与边界:',
    '- 你是外部实现者：只改代码、跑构建、截图、用 MCP 自验收。',
    '- 不改技术文档、不发版、不改版本号、不改 DSH 插件、不替用户拍板。',
    '- 需求之外的重构 / 依赖升级 / 全仓库格式化一律不做。',
    '',
    '开工顺序:',
    chat
      ? '1) 读上面 brief 第 5 节的文档/源码线索定位代码（单篇最大 258 KB，按小节读，不要整篇读）。'
      : '1) 读 brief.md 第 5 节的文档定位代码（单篇最大 258 KB，按小节读，不要整篇读）。',
    '2) 改代码 → 按第 3 节的命令在仓库目录内真跑构建，exit 0 才算过。',
    '3) 改界面时按第 7 节做视觉环：截图存 shots/，看完再改，收敛后再截一次。',
    '4) 按第 9 节的 JSON 模板回执。',
    '',
    '回执要求:',
    '- 整段 JSON 或 ```json 围栏都可以；status（done/partial/blocked）、summary、changed[] 三项必填。',
    '- changed[].file 用仓库相对路径，DSH 侧原样喂给文档同步。',
    '- screenshots[].path 相对 shots/，文件必须真实存在。',
    '- 没跑过的构建不许写 ok，没看过的界面不许写 pass；本机缺设备/MCP 就在回执里明说。',
    '',
    'DSH 侧拿到回执后会做文档同步与发版，所以不要自己动 docs/ 与版本号。',
  ].join('\n');
}
