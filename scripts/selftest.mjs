/**
 * 本地验证夹具：不启动 DSH，直接加载插件并按 DSH 的方式调用每个工具。
 *
 * 为什么要这个：DSH 的 desktop profile 由 Electron 独占，无法用 CLI 挂载做迭代验证。
 * 这个夹具用假的 `ctx.tools.register` 捕获注册结果，然后逐个执行工具，等价于
 * 「插件能加载 + 工具能跑通」，从而把「必须重启 DSH」的反馈环缩到秒级。
 */
// 相对本文件定位插件入口：这样脚本搬目录 / 改仓库位置都不用跟着改路径。
const pluginPath = new URL('../lib/impl.js', import.meta.url).href;

// 发布链路（§8/§9）要造一个**合成 git 仓库**才能钉住提交分类规则，
// 所以这里需要起进程；仓库夹具是自建的临时目录，不碰宿主上的任何真实仓库。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mod = await import(pluginPath);

console.log('=== 模块导出 ===');
console.log('name    =', mod.name);
console.log('inject  =', JSON.stringify(mod.inject));
console.log('exports =', Object.keys(mod).join(', '));
if (typeof mod.apply !== 'function') throw new Error('apply 不是函数 —— 插件契约不成立');

/**
 * 工作区根（三端仓库的父目录）—— 相对本文件推导，**不含作者机器路径**。
 * 本文件在 <workspace>/dsh-plugin-kirara-dev/scripts/ 下，所以上两级就是 workspace，
 * 与 cache-budget.mjs 的 WORKSPACE_ROOT 用同一套推导。
 * 插件按文档约定与 Kirara_Server_Studio / Kirara_Server-API / Kirara_Media 并列，
 * 因此换机器、换克隆位置都不用改这里。DSH_WORKSPACE 可覆盖（与插件自身的回退顺序一致）。
 */
const workspaceRoot = (process.env.DSH_WORKSPACE || '').trim()
  || fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '');

// 配置用 Config 的默认值 + 覆盖，模拟 DSH 传参
const config = { workspaceRoot, buildTimeoutMs: 1200000, buildLogTailLines: 60 };

const registered = new Map();
const ctx = {
  tools: {
    register(tool) {
      if (!tool || typeof tool.name !== 'string') throw new Error('register 收到非法 tool');
      if (registered.has(tool.name)) throw new Error('重复注册: ' + tool.name);
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
};

console.log('\n=== apply() ===');
try {
  mod.apply(ctx, config);
} catch (err) {
  console.error('apply() 失败:', err?.message || err);
  if (err?.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
console.log('已注册工具:', [...registered.keys()].join(', '));

// 校验每个工具的必备字段
for (const [n, t] of registered) {
  const problems = [];
  if (!t.description || t.description.length < 40) problems.push('description 过短');
  if (typeof t.execute !== 'function') problems.push('缺 execute');
  if (!t.parameters || typeof t.parameters !== 'object') problems.push('缺 parameters');
  if (!t.output || !t.output.schema) problems.push('缺 output.schema');
  // 注意：t.parameters 是 dsh-tools 编译后的 object 级 schema（schemastery 对象），
  // 不是「参数名 -> 定义」的映射；参数定义在 .properties 下。
  // 这里只做「结构存在且键对得上」的弱校验 —— required 的具体取值由 defineTool
  // 自己把关（非法 schema 会在 apply() 阶段直接抛 JsonSchemaError）。
  const params = t.parameters;
  if (!params || params.type !== 'object' || typeof params.properties !== 'object') {
    problems.push('parameters 不是 object 级 schema');
  } else {
    const req = params.required;
    const reqKeys = Array.isArray(req) ? req : Object.keys(req || {});
    for (const k of reqKeys) {
      if (!(k in params.properties)) problems.push(`required 里的 ${k} 不在 properties 中`);
    }
    for (const [pn, ps] of Object.entries(params.properties)) {
      if (!ps.type) problems.push(`参数 ${pn} 缺 type`);
    }
  }
  console.log(`  ${problems.length ? '✗' : '✓'} ${n}${problems.length ? ' -> ' + problems.join('; ') : ''}`);
}

// ── 逐个执行 ────────────────────────────────────────────────────────────────
async function call(toolName, args) {
  const t = registered.get(toolName);
  const value = await t.execute(args, { agent: null });
  const rendered = t.output.render ? t.output.render(args, value) : null;
  return { value, rendered };
}

console.log('\n=== 0. kirara_start（一句话启动，两种走向都要对） ===');
{
  // (a) 普通一句话小功能 → auto 应判为 small、不阻塞
  const a = await call('kirara_start', { request: '优化 kirara_docs 的关键词检索排序' });
  console.log('[a] 无界面小功能 auto -> mode =', a.value.mode, '| blocked =', a.value.blocked);
  console.log('    targets =', a.value.targets.map((t) => t.key).join(', '));
  console.log('    nextAction =', a.value.nextAction);

  // (b) 破坏性 + 涉表结构 → auto 必须升级为 full 且阻塞（不能当小功能草率放过）
  const b = await call('kirara_start', {
    request: '删除旧的评论表并重构为分表存储，需要改表结构和索引',
  });
  console.log('[b] 破坏性 auto     -> mode =', b.value.mode, '| blocked =', b.value.blocked);
  console.log('    decisions =', b.value.decisions.map((d) => `${d.id}(blocking=${d.blocking})`).join(', '));
  console.log('    nextAction =', b.value.nextAction);

  // (c) 空请求 → 必须阻塞追问，而不是瞎路由
  const c = await call('kirara_start', { request: '   ' });
  console.log('[c] 空请求          -> blocked =', c.value.blocked, '| decisions =', c.value.decisions.length);

  // (d) 文档清单不能太长（渐进式披露：只给该端的几篇，不塞整棵文档树）
  console.log('[d] docsToRead 条数 =', a.value.docsToRead.length,
    '| 每端最多 4 篇 =', a.value.docsToRead.every((d) => d.docs.length <= 4));

  // (e) 回归：UI 改动不能判 small（构建通过 ≠ 效果正确）。这是 DSH 实测暴露的假阴性。
  const e = await call('kirara_start', { request: '给设置页加个暗色开关' });
  console.log('[e] 暗色开关 auto    -> mode =', e.value.mode, '| blocked =', e.value.blocked,
    '| reasons =', (e.value.reasons || []).join('；'));
  console.log('    实机验证诉求      ->', e.value.targets.map((t) => t.key).join(', '),
    '| modeWhy =', e.value.modeWhy);

  // (f) 回归：仅凭「迁移」一词不能触发 DB 阻塞（假阳性）。同理不能靠「确认」蒙混，要索取细节。
  const f = await call('kirara_start', { request: '把设置页的登录迁移到新 API' });
  console.log('[f] 迁移到新 API     -> blocked =', f.value.blocked,
    '| 决策 =', f.value.decisions.map((d) => d.id).join(',') || '(无)');

  // (g) DB 变更提问必须①索取「改哪张表/哪些列」②不再把 EF 迁移当成要产出的东西（1.8.6 起已不在生效路径上）
  const g = await call('kirara_start', { request: '给用户表加一个 deviceToken 字段，需要改表结构' });
  const schemaQ = g.value.decisions.find((d) => d.id === 'schema');
  console.log('[g] 用户表加字段     -> blocked =', g.value.blocked, '| 有 schema 决策 =', Boolean(schemaQ));
  if (schemaQ) {
    console.log('    索取改哪张表/列 =', /改哪张表|哪些列/.test(schemaQ.question));
    console.log('    误把 EF 迁移当产物 =', /EF 迁移|EF migration/i.test(schemaQ.question));
    console.log('    指向 upgrade_v   =', /upgrade_v/.test(schemaQ.question));
    console.log('    提及 1.8.6 事实 =', /1\.8\.6/.test(schemaQ.question));
  }
  // (h) output schema 是 additionalProperties:false —— reasons 必须已在 schema 里声明，否则宿主会拒绝
  console.log('[h] reasons 已声明    ->',
    Boolean(registered.get('kirara_start').output.schema.properties.reasons),
    '| 空请求 reasons =', JSON.stringify(c.value.reasons));

  // (i) 纯文档变更 → auto 必须判 docs（免构建）。三类请求都要测：
  //     真·文档请求（要 docs）、文档里描述代码对象的请求（也要 docs）、
  //     以及「新增文档上传功能」这种**假阳性陷阱**（绝不能 docs）。
  const i1 = await call('kirara_start', { request: '同步一下文档' });
  console.log('[i1] 纯文档 auto        -> mode =', i1.value.mode, '| docsOnly =', i1.value.docsOnly,
    '| 建议先读 =', i1.value.docsToRead.map((d) => `${d.project}:${d.docs.length}篇`).join(', '));
  const i2 = await call('kirara_start', { request: '更新 API 完整文档里的评论接口章节' });
  console.log('[i2] 文档里含代码对象词 -> mode =', i2.value.mode, '| docsOnly =', i2.value.docsOnly, '（应 true：接口是被描述的对象）');
  const i3 = await call('kirara_start', { request: '新增文档上传功能' });
  console.log('[i3] 「文档+上传功能」   -> mode =', i3.value.mode, '| docsOnly =', i3.value.docsOnly, '（应 false：那是功能需求）');
  const i4 = await call('kirara_start', { request: '同步一下文档', mode: 'docs' });
  console.log('[i4] 显式 docs          -> mode =', i4.value.mode, '| 步骤 =', i4.value.steps.length,
    '| step1 =', i4.value.steps[0]);

  // (j) UI 改动 → 流程里必须出现截图环节。不看截图改样式 = 盲改。
  console.log('[j]  UI 流程含截图环节  ->', e.value.steps.some((s) => /截图/.test(s)),
    '| 含文档同步环节 =', e.value.steps.some((s) => /kirara_docsync/.test(s)));

  console.log('--- render ---');
  console.log(a.rendered[0].text.split('\n').slice(0, 8).join('\n'));
}

console.log('\n=== 1. kirara_profile ===');
{
  const { value, rendered } = await call('kirara_profile', {});
  console.log('workspaceRoot =', value.workspaceRoot);
  console.log('projects      =', value.projects.map((p) => `${p.key}${p.present ? '' : '(缺失!)'}`).join(', '));
  console.log('missing       =', JSON.stringify(value.missing));
  console.log('buildLines:');
  for (const p of value.projects) console.log('   ', p.key, '->', p.buildLine);
  console.log('--- render ---');
  console.log(rendered[0].text.split('\n').slice(0, 6).join('\n'));
}

console.log('\n=== 2. kirara_docs ===');
{
  const { value } = await call('kirara_docs', { keywords: ['幂等', '乐观更新'], maxHits: 5 });
  console.log('scannedFiles =', value.scannedFiles, ' hits =', value.hits.length, ' truncated =', value.truncated);
  for (const h of value.hits.slice(0, 5)) console.log(`   ${h.file}:${h.line} [${h.section}] ${h.text.slice(0, 90)}`);
}

console.log('\n=== 3. kirara_route (small，一句话小功能) ===');
{
  const { value } = await call('kirara_route', { request: '给安卓端设置页加一个深色模式切换开关', mode: 'small' });
  console.log('mode =', value.mode, ' requiresDeviceVerification =', value.requiresDeviceVerification);
  console.log('targets =', value.targets.map((t) => t.key).join(', '));
  console.log('decisions =', value.decisions.length);
  console.log('nextStep =', value.nextStep);
}

console.log('\n=== 4. kirara_route (full，破坏性改动 → 应挂起) ===');
{
  const { value } = await call('kirara_route', {
    request: '删除旧的评论表并重构为分表存储，需要改表结构',
    mode: 'full',
  });
  console.log('targets =', value.targets.map((t) => t.key).join(', '));
  console.log('decisions =', value.decisions.map((d) => `${d.id}(blocking=${d.blocking})`).join(', '));
  console.log('nextStep =', value.nextStep);
}

console.log('\n=== 4.5 kirara_route (docs，纯文档变更) ===');
{
  const { value } = await call('kirara_route', { request: '同步一下文档', mode: 'docs' });
  console.log('mode =', value.mode, '| 实机验证 =', value.requiresDeviceVerification, '| 计划 =', value.plan.length);
  console.log('nextStep =', value.nextStep);
}

console.log('\n=== 5. kirara_verify (small/docs 应跳过 / full 应给清单) ===');
{
  const a = await call('kirara_verify', { summary: 'x', project: 'media', mode: 'small' });
  console.log('small  -> skipped =', a.value.skipped);
  const b = await call('kirara_verify', { summary: '设置页加暗色开关', project: 'media', mode: 'full' });
  console.log('full   -> steps =', b.value.steps.length);
  console.log('  第1步:', b.value.steps[0].action, '|', b.value.steps[0].expected);
  // 截图复核：一个真实存在的文件 + 一个不存在的，确认 exists 判定与协议生成都对
  const c = await call('kirara_verify', {
    summary: '设置页加暗色开关',
    project: 'media',
    mode: 'full',
    screenshots: [import.meta.filename, 'D:/nope/does-not-exist.png'],
  });
  const sr = c.value.screenshotReview;
  console.log('screenshotReview -> provider/model =', `${sr.provider}/${sr.model}`);
  console.log('  screenshots =', sr.screenshots.map((s) => `${s.exists ? '存在' : '缺失'}:${s.path}`).join(' , '));
  console.log('  render 含截图段 =', c.rendered[0].text.includes('截图复核协议'));
  console.log('  howToInstall:', b.value.howToInstall);

  // 纯文档变更：没有可验的东西，必须走 skipped 而不是给一份空清单
  const d = await call('kirara_verify', { summary: 'x', project: 'desktop', mode: 'docs' });
  console.log('docs   -> skipped =', d.value.skipped, '| steps =', d.value.steps.length);

  // UI 改动没传截图 → 必须明确索取截图（这是「UI 必经截图」的机器化兜底）
  const uiNoShot = await call('kirara_verify', { summary: '首页配色调整', project: 'desktop', mode: 'full' });
  console.log('UI 无截图 -> needScreenshots =', Boolean(uiNoShot.value.needScreenshots), '| steps =', uiNoShot.value.steps.length);
  console.log('  清单含截图步骤 =', uiNoShot.value.steps.some((s) => /截图/.test(s.action)));

  // purpose=ui-design：协议问的是「怎么改」，不是「过没过」
  const uiDesign = await call('kirara_verify', {
    summary: '设置页加暗色开关',
    project: 'media',
    mode: 'full',
    purpose: 'ui-design',
    screenshots: [import.meta.filename],
  });
  const instr = uiDesign.value.screenshotReview.instruction;
  console.log('ui-design -> purpose =', uiDesign.value.screenshotReview.purpose,
    '| needScreenshots =', Boolean(uiDesign.value.needScreenshots));
  console.log('  协议含 P0/P1 =', /P0/.test(instr) && /P1/.test(instr),
    '| 协议要求重截复核 =', /重新截图/.test(instr),
    '| render 硬截断 =', /输出已被 kirara-dev 截断/.test(uiDesign.rendered[0].text));
}

console.log('\n=== 5.5 kirara_docsync（自行判断该同步哪几篇文档） ===');
{
  for (const [feature, changes] of [
    ['新增评论 @ 提醒功能', ['Kirara_Server-API/Controllers/CommentsController.cs']],
    ['修复令牌扫码导入失败', ['Kirara_Server-API/Services/TokenImportService.cs']],
    ['格式化代码并重命名变量', ['Kirara_Server_Studio/Services/Foo.cs']],
    ['更新技术栈文档里的 Gradle 版本', []],
  ]) {
    const { value } = await call('kirara_docsync', { feature, changes });
    console.log(`  「${feature}」 -> kind=${value.kind} required=${value.required} targets=${value.targets.length}`);
    for (const t of value.targets) console.log(`      ${t.rel}  [${t.sections.join(' / ')}]`);
  }
  // 显式 kind 与 project 覆盖：判定能被人为收口，而不是只能接受启发式结果
  const ch = await call('kirara_docsync', { feature: '常规迭代', changes: [], kind: 'chore', project: 'media' });
  console.log('  显式 chore -> required =', ch.value.required, '| targets =', ch.value.targets.length,
    '| 清单 =', ch.value.checklist.length);
  const api = await call('kirara_docsync', { feature: '接口鉴权调整', changes: [], project: 'api' });
  console.log('  限定 api   -> targets =', api.value.targets.map((t) => t.rel).join(', ') || '(无)');
}

console.log('\n=== 6. kirara_summary ===');
{
  const { value } = await call('kirara_summary', {
    feature: '设置页深色模式开关',
    mode: 'small',
    changes: ['Kirara_Media/app/src/main/java/.../SettingsScreen.kt'],
    builds: ['media: 待构建'],
    risks: [],
  });
  console.log(value.markdown.split('\n').slice(0, 10).join('\n'));
}

// ⚠️ 这一节直调 execute()，**绕过宿主的 lossless 快照与 output schema 校验**。
// 因此它“构建成功”并不能证明工具在 DSH 里可用 —— 2026-10-05 的
// `tool "kirara_build" returned invalid output` 就是这样漏过去的：本地 exit=0，
// 宿主却因返回值里的 undefined 整次拒收。返回值边界由 contract-test.mjs §6.5 负責。

console.log('\n=== 8. kirara_release_notes（git → 新增功能，BUG/修复必须分出去） ===');
{
  // (a) 真实仓库：desktop 有 tag 1.6.5，区间应落在 tag 上而不是首个提交
  const d = await call('kirara_release_notes', { project: 'desktop' });
  console.log('[a] desktop -> from =', d.value.from, '(' + d.value.fromKind + ')',
    '| 提交', d.value.commitCount, '| 计数', JSON.stringify(d.value.counts));
  console.log('    README 门禁 =', JSON.stringify(d.value.readme.map((r) => r.rel + ':' + r.gate)));
  console.log('    修复桶里有内容 =', d.value.fixes.length > 0, '| features 里混进修复 =',
    d.value.features.some((f) => /修复|修正|bug/i.test(f.subject)));

  // (b) media：4 条提交的窄区间，fixes 必须为空
  const m = await call('kirara_release_notes', { project: 'media' });
  console.log('[b] media   -> from =', m.value.from, '| 提交', m.value.commitCount,
    '| 计数', JSON.stringify(m.value.counts));
  // 关键回归：这条标题同时含 feat 与「修正」，必须按 feat 归到新增功能，不能当修复丢掉。
  const trap = m.value.features.find((f) => /应用内更新/.test(f.subject));
  console.log('    feat+修正陷阱 -> 归入 features =', Boolean(trap));
  console.log('    fixes 桶         =', m.value.fixes.length, '（应为 0）');

  // (c) api：没有任何版本 tag ⇒ 必须退回首个提交并**明确警示**，而不是静默给个空区间
  const a = await call('kirara_release_notes', { project: 'api' });
  console.log('[c] api     -> fromKind =', a.value.fromKind, '| 提交', a.value.commitCount,
    '| 计数', JSON.stringify(a.value.counts));
  console.log('    警示了 tag 缺失   =', a.value.warnings.some((w) => /没有任何版本 tag/.test(w)));
  console.log('    折叠了重复提交   =', a.value.warnings.some((w) => /折叠/.test(w)));
  console.log('    readme 为空(跳过) =', a.value.readme.length === 0);

  // (d) 显式 from 必须能收窄区间（人拍板的入口）。顺带确认 enum 参数是被真校验的：
  //     defineTool 会在 execute 之前把非法 project 直接拒掉，所以这里不用造「未知项目」用例。
  const pinned = await call('kirara_release_notes', { project: 'api', from: '3e1143d' });
  console.log('[d] 显式 from  -> fromKind =', pinned.value.fromKind, '| 提交', pinned.value.commitCount,
    '（应远小于 44）');
}

console.log('\n=== 8.5 合成 git 仓库：提交分类与去重规则 ===');
{
  // 为什么自建仓库：真实仓库的提交内容会随时间变化，规则回归需要一个**可控**的输入。
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'kirara-notes-'));
  const repo = join(fixtureRoot, 'Kirara_Media');
  mkdirSync(join(repo, 'app'), { recursive: true });
  writeFileSync(join(repo, 'app', 'build.gradle.kts'), 'versionCode = 9\nversionName = "0.9.8-beta"\n');
  writeFileSync(join(repo, 'README.md'), '# Kirara_Media\n## 功能特性\n');
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 失败: ' + (r.stderr || r.stdout));
    return (r.stdout || '').trim();
  };
  const commit = (subject) => git(['commit', '--allow-empty', '--no-verify', '-m', subject]);
  git(['init']);
  git(['config', 'user.name', 'fixture']);
  git(['config', 'user.email', 'fixture@local']);
  git(['config', 'commit.gpgsign', 'false']);
  commit('初始提交');
  git(['tag', 'v0.9.6-beta']);
  commit('打底提交');
  git(['tag', 'v0.9.7-beta']);
  commit('feat(应用内更新): 应用内 APK 下载/校验/安装，并修正互动预览（0.9.7-beta）');
  commit('新增扫码导入功能');
  commit('新增扫码导入功能'); // 分支合并的同标题重复
  commit('修复登录崩溃');
  commit('更新README');
  commit('perf: 压缩缓存');

  const savedRoot = config.workspaceRoot;
  config.workspaceRoot = fixtureRoot;
  try {
    const { value } = await call('kirara_release_notes', { project: 'media' });
    console.log('from      =', value.from, '(' + value.fromKind + ')  （应 v0.9.7-beta / tag）');
    console.log('commitCount =', value.commitCount, '（8 条提交 - 1 条已打 tag 之前 = 6，再去重 1 = 5）');
    console.log('counts    =', JSON.stringify(value.counts),
      '（应 {"features":2,"fixes":1,"internal":2,"ambiguous":0}）');
    console.log('features  =', value.features.map((f) => f.subject.slice(0, 24)).join(' | '));
    console.log('fixes     =', value.fixes.map((f) => f.subject).join(' | '));
    console.log('折叠重复   =', value.warnings.some((w) => /折叠/.test(w)));

    // 前置检查必须真的拦：夹具里没有 keystore.properties ⇒ media 的签名门禁先失败，
    // 而不是等 gradle 跑一轮再报错。
    const noKey = await call('kirara_release', { project: 'media', dryRun: true });
    console.log('前置拦截  -> blocked =', noKey.value.blocked,
      '| 命中签名缺失 =', noKey.value.blockers.some((b) => /keystore\.properties/.test(b)),
      '| 未产出步骤 =', noKey.value.steps.length === 0);

    writeFileSync(join(repo, 'keystore.properties'), 'storeFile=release.jks\nstorePassword=x\nkeyAlias=a\nkeyPassword=x\n');
    // media 是 script 模式 ⇒ 两步（跑脚本 + 核验校验码），脚本自己负责桌面输出与 SHA256。
    const dry = await call('kirara_release', { project: 'media', dryRun: true });
    console.log('dryRun    -> blocked =', dry.value.blocked, '| 版本', dry.value.version,
      '| 步骤 =', dry.value.steps.map((s) => s.id + ':' + s.status).join(', '));
    // 该 README 从不写版本号 ⇒ 门禁必须只提醒、不阻断（永远拦人的门禁等于没有门禁）
    console.log('            README 不写版本号时不拦截 =', !dry.value.blocked,
      '| 有提醒 =', dry.value.warnings.some((w) => /无法核验/.test(w)));
  } finally {
    config.workspaceRoot = savedRoot;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

console.log('\n=== 9. kirara_release（dryRun 计划 / 前置拦截） ===');
{
  const d = await call('kirara_release', { project: 'desktop', dryRun: true });
  console.log('desktop -> blocked =', d.value.blocked, '| 版本', d.value.previousVersion, '→', d.value.version,
    '(bump=' + d.value.bump + ')');
  console.log('  步骤:', d.value.steps.map((s) => s.title).join(' / '));
  console.log('  产物名带 _v 后缀 =', d.value.steps.some((s) => /_v\{?版本/.test(s.title) || /_v/.test(s.command)),
    '| 有 SHA256 步骤 =', d.value.steps.some((s) => /SHA256/.test(s.title)));

  const m = await call('kirara_release', { project: 'media', dryRun: true });
  console.log('media   -> blocked =', m.value.blocked, '| 版本', m.value.version,
    '| 步骤 =', m.value.steps.map((s) => s.id).join(', '));
  console.log('  脚本参数含版本号 =', m.value.steps.some((s) => s.command.includes('-Version ' + m.value.version)));

  const a = await call('kirara_release', { project: 'api', dryRun: true });
  console.log('api     -> 版本', a.value.previousVersion, '→', a.value.version, '(bump=' + a.value.bump + ')');
  console.log('  blocked =', a.value.blocked, '| blockers =', JSON.stringify(a.value.blockers.slice(0, 1)));

  // 版本号显式覆盖必须生效（人拍板的入口）
  const pinned = await call('kirara_release', { project: 'desktop', version: '9.9.9', dryRun: true });
  console.log('显式 version -> ', pinned.value.version, '（应 9.9.9）');

  // 输出必须是 lossless JSON：可选键（artifact / sha256 / checksumFile / logTail）必须整键省略
  const walk = (x, path, out) => {
    if (x === undefined) { out.push(path); return; }
    if (x === null || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((v, i) => walk(v, path + '[' + i + ']', out)); return; }
    for (const k of Object.keys(x)) walk(x[k], path + '.' + k, out);
  };
  for (const [label, v] of [['desktop', d.value], ['media', m.value], ['api', a.value]]) {
    const bad = [];
    walk(v, label, bad);
    console.log('  ' + label + ' 返回值无 undefined =', bad.length === 0, bad.join(', '));
  }
}

console.log('\n=== 7. kirara_build (真实构建 api 端) ===');
try {
  const t0 = Date.now();
  const { value, rendered } = await call('kirara_build', { project: 'api' });
  console.log('ok =', value.ok, ' exit =', value.exitCode, ' duration =', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('errors =', JSON.stringify(value.errors));
  console.log('--- render ---');
  console.log(rendered[0].text.split('\n').slice(0, 4).join('\n'));
} catch (err) {
  console.error('kirara_build 抛异常:', err?.message || err);
  console.error((err?.stack || '').split('\n').slice(0, 8).join('\n'));
}

console.log('\n=== 全部工具执行完毕，插件自检通过 ===');
