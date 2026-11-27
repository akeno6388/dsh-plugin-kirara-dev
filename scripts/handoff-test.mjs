/**
 * 外部强模型交接（kirara_handoff）回归夹具。
 *
 * 它守的是四类**结构性**错误 —— 都属于「一旦写错，下一轮就会拿错事实继续干」的那种：
 *   ① 交接包不全：brief 少一节 / 少构建命令 / 少 SAFETY_RULES ⇒ 外部实现者按残缺事实开工；
 *   ② 返回值超预算：brief 正文一次灌进几 KB ⇒ 前缀缓存被提前挤爆（见 lib/impl.js 文件头）；
 *   ③ 回执校验太松：缺 status/summary/changed 也写 report.json ⇒ 下一步的文档同步拿它当事实；
 *   ④ 路径穿越：`runId: '../../x'` 把文件写到交接目录之外。
 *
 * 跑法：node --no-warnings scripts/handoff-test.mjs
 * 退出码 0 = 全部通过。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pluginPath = new URL('../lib/impl.js', import.meta.url).href;
const mod = await import(pluginPath);

let failures = 0;
const ok = (msg, detail) => console.log(`  ✓ ${msg}${detail ? `\n      ${detail}` : ''}`);
const bad = (msg, detail) => {
  failures += 1;
  console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`);
};
const check = (cond, msg, detail) => (cond ? ok(msg, detail) : bad(msg, detail));
/** 读 JSON；文件不存在时返回 null —— 夹具要把失败项打印出来，而不是自己抛 ENOENT 中断。 */
const readJsonSafe = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// ── 临时工作区：造一个「够真」的 Kirara_Media，让文档检索真的能命中 ──────────────
const tmp = mkdtempSync(join(tmpdir(), 'kirara-handoff-test-'));
const media = join(tmp, 'Kirara_Media');
mkdirSync(join(media, 'app', 'docs'), { recursive: true });
writeFileSync(
  join(media, 'app', 'docs', 'Kirara Media 安卓版技术栈文档.md'),
  [
    '# Kirara Media 安卓技术栈',
    '',
    '## 设置页',
    '',
    '- 设置页第二组是「显示」；暗色模式开关放在这里，默认跟随系统。',
    '- 开关状态存在 LiteDB / DataStore，不要放进 SharedPreferences。',
    '',
  ].join('\n'),
  'utf8',
);

// 分章文档集（≥2 个 NN-标题.md 才会被当成章）—— 用来验证 brief 第 5 节的「源码线索」：
// frontmatter.files 里有**真实存在的文件**、也**有一个不存在的**（必须被过滤掉，绝不许出死链）。
const chapters = join(media, 'app', 'docs', '技术栈文档');
mkdirSync(chapters, { recursive: true });
const realSettings = join(media, 'app', 'src', 'main', 'java', 'com', 'akeno', 'kirara', 'SettingsScreen.kt');
mkdirSync(join(media, 'app', 'src', 'main', 'java', 'com', 'akeno', 'kirara'), { recursive: true });
writeFileSync(realSettings, '// 设置页：暗色模式开关\n', 'utf8');
const sharedSettingsDir = join(media, 'shared', 'src', 'commonMain', 'kotlin', 'com', 'akeno', 'kirara', 'media', 'ui', 'settings');
mkdirSync(sharedSettingsDir, { recursive: true });
writeFileSync(join(sharedSettingsDir, 'SettingsStore.kt'), '// DataStore 里的开关状态\n', 'utf8');
const realUpdate = join(media, 'app', 'src', 'main', 'java', 'com', 'akeno', 'kirara', 'UpdateScreen.kt');
writeFileSync(realUpdate, '// 更新页\n', 'utf8');
writeFileSync(
  join(chapters, '09-设置与账号.md'),
  [
    '---',
    'module: 设置与账号',
    'level: 能力层',
    'files:',
    '  - app/src/main/java/com/akeno/kirara/SettingsScreen.kt',
    '  - app/src/main/java/com/akeno/kirara/GhostScreen.kt',
    '  - shared/src/commonMain/kotlin/com/akeno/kirara/media/ui/settings/',
    '  - app/src/main/java/com/akeno/kirara/ui/{Theme,Color}.kt',
    'related: [10-更新与发布.md]',
    '---',
    '',
    '# 09 设置与账号',
    '',
    '<a id="settings"></a>',
    '## 09.1 设置页分区',
    '',
    '设置页第二组是「显示」，暗色模式开关放在这里，默认跟随系统。',
    '安卓端开关状态存进 DataStore，不要放进 SharedPreferences。',
    '',
    '## 09.2 暗色模式',
    '',
    '暗色模式在设置页只给「跟随系统 / 浅色 / 深色」三档，不要加第四档。',
    '',
  ].join('\n'),
  'utf8',
);
writeFileSync(
  join(chapters, '10-更新与发布.md'),
  [
    '---',
    'module: 更新与发布',
    'level: 能力层',
    'files:',
    '  - app/src/main/java/com/akeno/kirara/UpdateScreen.kt',
    'related: [09-设置与账号.md]',
    '---',
    '',
    '# 10 更新与发布',
    '',
    '## 10.1 检查更新',
    '',
    '更新页展示当前版本号与最新版本号。',
    '',
  ].join('\n'),
  'utf8',
);

// media 在 PROJECTS 里登记的 README（死链自检的「正常」基线；后面会故意删掉一份造死链）。
mkdirSync(join(media, 'iosApp'), { recursive: true });
writeFileSync(join(media, 'README.md'), '# Kirara Media\n', 'utf8');
writeFileSync(join(media, 'iosApp', 'README.md'), '# iosApp\n', 'utf8');

// 假 gradlew：verifyBuild="rerun" 要在临时工作区里真的起一次进程（不碰真实仓库）。
// 内容可被用例改写：exit 0 = 构建成功，exit 1 = 构建失败（用来验证「不一致」不会让 close 失败）。
const fakeGradle = join(media, 'gradlew.bat');
const writeFakeGradle = (code) =>
  writeFileSync(fakeGradle, `@echo off\r\necho fake gradle %*\r\nexit /b ${code}\r\n`, 'utf8');
writeFakeGradle(0);

const registered = new Map();
const ctx = {
  tools: {
    register(tool) {
      if (registered.has(tool.name)) throw new Error(`重复注册: ${tool.name}`);
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
};
mod.apply(ctx, { workspaceRoot: tmp });
const handoffRoot = join(tmp, '.kirara-dev', 'handoff');

async function call(args) {
  const tool = registered.get('kirara_handoff');
  const value = await tool.execute(args, { agent: null });
  const text = (tool.output.render ? tool.output.render(args, value) : []).map((b) => b.text ?? '').join('');
  return { value, text };
}

/** 调别的工具（这里主要是 kirara_profile 的死链自检）。 */
async function callNamed(name, args) {
  const tool = registered.get(name);
  const value = await tool.execute(args, { agent: null });
  const text = (tool.output.render ? tool.output.render(args, value) : []).map((b) => b.text ?? '').join('');
  return { value, text };
}

try {
  // ── 0. 工具面：删掉 kirara_route、新增 kirara_handoff，总数仍是 11 ─────────────
  console.log('=== 0. 工具面 ===');
  const names = [...registered.keys()].sort();
  check(names.length === 11, `注册工具数 = ${names.length}（应 11）`, names.join(', '));
  check(!registered.has('kirara_route'), 'kirara_route 已并入 kirara_start（不再单独注册）');
  check(registered.has('kirara_handoff'), 'kirara_handoff 已注册');
  const startDef = registered.get('kirara_start');
  check(
    Boolean(startDef?.parameters?.properties?.detail),
    'kirara_start 有 detail 参数',
    JSON.stringify(startDef?.parameters?.properties?.detail?.enum ?? []),
  );

  // ── 1. open：落盘 5 个条目，brief 九节齐全且都有内容 ─────────────────────────
  console.log('\n=== 1. open 落盘与 brief 九节 ===');
  const open1 = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关' });
  check(open1.value.ok === true, 'open 返回 ok', `runId=${open1.value.runId} mode=${open1.value.mode}`);
  check(/^KH-\d{8}-\d{4}(-\d+)?$/.test(open1.value.runId || ''), `runId 形态合法：${open1.value.runId}`);
  check(open1.value.mode === 'full', `mode 判定 = ${open1.value.mode}（界面改动应按 full）`);

  const dir1 = open1.value.dir;
  const entries = ['brief.md', 'brief.json', 'prompt.md', 'README.txt'];
  for (const name of entries) {
    const p = join(dir1, name);
    check(existsSync(p) && statSync(p).isFile(), `open 写出 ${name}`, p);
  }
  check(existsSync(join(dir1, 'shots')) && statSync(join(dir1, 'shots')).isDirectory(), 'open 建出 shots/ 目录（第 5 个条目）');
  check(
    readdirSync(dir1).length === 5,
    `目录条目 = ${readdirSync(dir1).length}（4 文件 + shots/）`,
    readdirSync(dir1).join(', '),
  );

  const brief = readFileSync(join(dir1, 'brief.md'), 'utf8');
  const sectionTitles = [
    '1. 任务卡',
    '2. 你的边界',
    '3. 涉及端',
    '4. 必读事实',
    '5. 代码定位线索',
    '6. 文档片段',
    '7. 验收标准',
    '8. MCP 用法',
    '9. 回执格式',
  ];
  const missingSections = sectionTitles.filter((t) => !brief.includes(`## ${t}`));
  check(missingSections.length === 0, `brief 含 9 个章节标题`, missingSections.length ? `缺: ${missingSections.join(' / ')}` : '');
  // 「每节都要有内容，不允许只留标题」：逐节取到下一个 `## N.` 之前，正文必须够长。
  const bodies = sectionTitles.map((t) => {
    const start = brief.indexOf(`## ${t}`);
    if (start < 0) return '';
    const rest = brief.slice(start + `## ${t}`.length);
    const next = rest.search(/\n## \d\. /);
    return (next < 0 ? rest : rest.slice(0, next)).trim();
  });
  const empty = sectionTitles.filter((_, i) => bodies[i].length < 20);
  check(empty.length === 0, '九节都有正文（不是只留标题）', empty.length ? `空节: ${empty.join(' / ')}` : `最短正文 ${Math.min(...bodies.map((b) => b.length))} 字符`);
  check(/gradlew\.bat assembleDebug/.test(brief), 'brief 含 media 的构建命令');
  check(/dotnet\.exe/.test(brief) && /build-server shutdown/.test(brief), 'brief 原样带上 SAFETY_RULES 的两条红线');
  check(/Kirara_Media\/app\/docs\/.*:\d+/.test(brief), 'brief 第 6 节带 文件:行号 的文档命中');
  check(brief.includes('shots/'), 'brief 指明截图写进 shots/');
  const briefJson = readJsonSafe(join(dir1, 'brief.json'));
  check(briefJson?.runId === open1.value.runId && briefJson?.mode === 'full', 'brief.json 与 brief.md 同源（runId/mode 一致）');
  const promptMd = readFileSync(join(dir1, 'prompt.md'), 'utf8');
  check(
    promptMd.length >= 700 && promptMd.length <= 1600,
    `prompt.md 长度 = ${promptMd.length} 字符（目标 800–1200 量级）`,
  );
  check(/report|回执/.test(promptMd) && /brief\.md/.test(promptMd), 'prompt.md 说明「读 brief.md → 干活 → 回执」');

  // ── 2. 返回值预算：inline=false ≤ 2400；inline=true ≤ handoffBudgetChars(6000) ──
  console.log('\n=== 2. 返回值预算 ===');
  check(open1.text.length <= 2400, `inline=false 的返回正文 ${open1.text.length} ≤ 2400 字符`);
  check(!/undefined/.test(open1.text), 'inline=false 的返回正文不含 undefined');
  const openInline = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关', inline: true });
  check(openInline.text.length <= 6000, `inline=true 的返回正文 ${openInline.text.length} ≤ 6000 字符（handoffBudgetChars）`);
  check(!/undefined|NaN/.test(openInline.text), 'inline=true 的返回正文不含 undefined / NaN');
  check(openInline.value.brief && openInline.text.includes('## 9. 回执格式'), 'inline=true 带了 brief 正文');
  const undefKeys = Object.entries(openInline.value).filter(([, v]) => v === undefined).map(([k]) => k);
  check(undefKeys.length === 0, '返回值无显式 undefined 键（否则宿主会拒收整次调用）', undefKeys.join(', ') || '(无)');
  // 超长需求 + inline=false：prompt 里含需求原文，所以这条路径也必须被硬预算收口。
  const openHuge = await call({ action: 'open', request: `给安卓端设置页加暗色模式开关 ${'x'.repeat(2000)}` });
  check(openHuge.text.length <= 2400, `超长需求 + inline=false 的返回正文 ${openHuge.text.length} ≤ 2400 字符`);
  check(/截断/.test(openHuge.text), '超长需求被截断时说明了去哪看完整版');

  // ── 3. close：整段 JSON 与 ```json 围栏两种形态 ─────────────────────────────
  console.log('\n=== 3. close 的两种回执形态 ===');
  writeFileSync(join(dir1, 'shots', 'shot-01.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const report = {
    runId: open1.value.runId,
    status: 'done',
    summary: '设置页加了暗色开关，默认跟随系统',
    changed: [{ file: 'Kirara_Media/app/src/main/java/com/akeno/kirara/SettingsScreen.kt', why: '加开关与状态持久化' }],
    commands: [{ cmd: 'gradlew.bat assembleDebug', exit: 0, note: '48s' }],
    screenshots: [{ path: 'shots/shot-01.png', state: '设置页-深色', note: '改后' }],
    verification: {
      build: 'ok',
      uiLoop: 'closed',
      acceptance: [{ item: '暗色开关可切换且重启后保持', result: 'pass', evidence: 'shot-01.png' }],
    },
    docsHint: ['SettingsScreen 的默认值变了，需更新技术栈文档「设置页」一节'],
    openIssues: [],
    blockedBy: null,
  };
  const close1 = await call({ action: 'close', runId: open1.value.runId, report: JSON.stringify(report) });
  check(close1.value.ok === true, 'close（纯 JSON）通过', close1.value.error || '');
  check(close1.value.status === 'done' && close1.value.changed.length === 1, 'close 回出 status / changed');
  check(
    close1.value.changed[0] === 'Kirara_Media/app/src/main/java/com/akeno/kirara/SettingsScreen.kt',
    'changed[] 原样保留文件路径（可直接喂 kirara_docsync）',
  );
  check(existsSync(join(dir1, 'report.md')) && existsSync(join(dir1, 'report.json')), 'close 写出 report.md + report.json');
  const savedReport = readJsonSafe(join(dir1, 'report.json'));
  check(savedReport?.screenshots?.[0]?.exists === true, 'report.json 里截图 stat 结果 = true');
  check(savedReport?.parsedFrom === 'bare', `report.json 记录了回执形态：${savedReport?.parsedFrom}`);
  check(/kirara_docsync/.test(close1.value.nextStep) && /kirara_summary/.test(close1.value.nextStep), 'nextStep 指明 docsync → summary');

  // 围栏形态 + 显式 runId
  const open2 = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关' });
  const fenced = '```json\n' + JSON.stringify({ ...report, runId: open2.value.runId, summary: '围栏形态回执' }) + '\n```';
  const close2 = await call({ action: 'close', runId: open2.value.runId, report: fenced });
  check(close2.value.ok === true && close2.value.summary === '围栏形态回执', 'close（```json 围栏 + 显式 runId）通过');
  const saved2 = readJsonSafe(join(open2.value.dir, 'report.json'));
  check(saved2?.parsedFrom === 'fenced', `report.json 记录形态 = ${saved2?.parsedFrom}`);

  // ── 4. 缺 status ⇒ 拒收，且不写 report.json ─────────────────────────────────
  console.log('\n=== 4. 缺必填项必须拒收 ===');
  const open3 = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关' });
  const noStatus = await call({
    action: 'close',
    runId: open3.value.runId,
    report: JSON.stringify({ summary: '只说了做了什么', changed: [{ file: 'a.kt' }] }),
  });
  check(noStatus.value.ok === false, 'close 缺 status → ok=false');
  check(/(status)/.test((noStatus.value.missing || []).join(' ')), '明确指出缺的是 status', (noStatus.value.missing || []).join(' / '));
  check(!existsSync(join(open3.value.dir, 'report.json')), '拒收时**没有**写 report.json');
  const noChanged = await call({
    action: 'close',
    runId: open3.value.runId,
    report: JSON.stringify({ status: 'done', summary: 'x' }),
  });
  check(noChanged.value.ok === false && /changed/.test((noChanged.value.missing || []).join(' ')), 'close 缺 changed → 明确指出');
  const notJson = await call({ action: 'close', runId: open3.value.runId, report: '我把代码改完了，构建也过了。' });
  check(notJson.value.ok === false, 'close 收到非 JSON 回执 → 拒收而不是崩');

  // ── 5. 截图指向不存在的文件 ⇒ 明确列出，不静默丢 ────────────────────────────
  console.log('\n=== 5. 缺失截图必须点名 ===');
  const open4 = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关' });
  const ghost = await call({
    action: 'close',
    runId: open4.value.runId,
    report: JSON.stringify({
      status: 'partial',
      summary: '改了但只截了一张',
      changed: [{ file: 'Kirara_Media/app/src/main/java/com/akeno/kirara/SettingsScreen.kt', why: 'x' }],
      screenshots: [{ path: 'shots/shot-09.png' }, { path: '../../../etc/passwd' }],
    }),
  });
  check(ghost.value.ok === true, 'close 遇到不存在的截图仍然完成（不崩）');
  check(
    (ghost.value.missingScreenshots || []).includes('shots/shot-09.png'),
    '缺失截图被明确列出',
    (ghost.value.missingScreenshots || []).join(', '),
  );
  check(
    ghost.value.screenshots.some((s) => s.path === '../../../etc/passwd' && s.outside === true),
    '越界的截图路径标成 outside（不 stat 到交接目录之外）',
  );
  check(/缺失/.test(ghost.text) && /截图/.test(ghost.text), '渲染里说明截图缺失');

  // ── 6. 路径穿越被拒 ─────────────────────────────────────────────────────────
  console.log('\n=== 6. runId 路径穿越 ===');
  const before = readdirSync(handoffRoot).sort().join(',');
  const escape = await call({ action: 'close', runId: '../../x', report: JSON.stringify(report) });
  check(escape.value.ok === false, 'runId=../../x → 拒绝');
  check(/非法|越界/.test(escape.value.error || ''), `拒绝理由明确：${escape.value.error}`);
  check(!existsSync(join(tmp, 'x')) && !existsSync(join(tmp, '.kirara-dev', 'x')), '没有在交接目录之外创建任何目录');
  check(readdirSync(handoffRoot).sort().join(',') === before, '交接目录里也没有多出/少掉条目');
  const badOpen = await call({ action: 'close', runId: 'KH-20260101-0000', report: JSON.stringify(report) });
  check(badOpen.value.ok === false && /不存在/.test(badOpen.value.error || ''), '不存在的 runId → 明确报错');

  // ── 7. 连续两次 open：runId 不同、目录互不覆盖 ──────────────────────────────
  console.log('\n=== 7. 连续 open 不覆盖 ===');
  const a = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关' });
  const b = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关' });
  check(a.value.runId !== b.value.runId, `两次 open 的 runId 不同：${a.value.runId} / ${b.value.runId}`);
  check(a.value.dir !== b.value.dir, '两次 open 的目录不同');
  check(
    readFileSync(join(a.value.dir, 'brief.md'), 'utf8').includes(a.value.runId) &&
      readFileSync(join(b.value.dir, 'brief.md'), 'utf8').includes(b.value.runId),
    '两个目录各自保留自己的 brief（互不覆盖）',
  );
  const newest = await call({ action: 'close', report: JSON.stringify({ ...report, summary: '缺省取最新一次' }) });
  check(newest.value.runId === b.value.runId, `close 缺省取最新一次：${newest.value.runId}`, `期望 ${b.value.runId}`);

  // ── 8. 参数缺失 / 非法 action：不抛异常、不落盘 ────────────────────────────
  console.log('\n=== 8. 入参边界 ===');
  const noReq = await call({ action: 'open' });
  check(noReq.value.ok === false && /request/.test(noReq.value.error || ''), 'open 缺 request → ok=false（不建目录）');
  // 枚举外的 action 由 defineTool 的参数校验直接拒（连 execute 都进不去）——
  // 这正是想要的：非法入参不该有机会碰文件系统。夹具按「抛 ToolArgsError」断言。
  let weird;
  try {
    weird = await call({ action: 'nope' });
  } catch (error) {
    weird = { value: { ok: false, error: String(error?.message ?? error) }, text: '' };
  }
  check(weird.value.ok === false && /action/.test(weird.value.error || ''), '未知 action → 参数校验直接拒绝（不会走进 execute）', weird.value.error);

  // ── 9. brief 第 5 节的源码线索（frontmatter.files → 真实路径，绝不出死链）────────
  console.log('\n=== 9. brief 第 5 节源码线索 ===');
  {
    const hintLines = bodies[4]
      .split('\n')
      .filter((l) => /（来自 .* 章的 files）/.test(l));
    check(hintLines.length >= 1, `第 5 节带源码线索 ${hintLines.length} 条`, hintLines.slice(0, 3).join(' | '));
    check(
      hintLines.some((l) => l.includes('Kirara_Media/app/src/main/java/com/akeno/kirara/SettingsScreen.kt')),
      '线索里出现真实存在的源文件（SettingsScreen.kt）',
    );
    check(
      !hintLines.some((l) => l.includes('GhostScreen.kt')),
      '不存在的源文件（GhostScreen.kt）被 existsSync 过滤掉',
      hintLines.filter((l) => l.includes('Ghost')).join(' | ') || '(没有)',
    );
    // 逐条落到磁盘：这是「绝不允许死链」的机器断言（目录条目按目录存在性判断）。
    const dead = hintLines
      .map((l) => l.replace(/^\s*-\s*/, '').replace(/（来自 .*$/, '').trim())
      .filter((rel) => !existsSync(join(tmp, rel.replace(/\/$/, ''))));
    check(dead.length === 0, '线索里的每一条路径都真实存在（无死链）', dead.join(', ') || '(全部存在)');
    check(
      Array.isArray(briefJson?.codeHints) && briefJson.codeHints.length === hintLines.length,
      `brief.json 与 brief.md 的 codeHints 同源（${briefJson?.codeHints?.length ?? 0} 条）`,
    );
  }

  // ── 10. executor=chat：brief 正文直接进返回值（读不到本地文件的外部模型）─────────
  console.log('\n=== 10. executor=chat ===');
  const chatOpen = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关', executor: 'chat' });
  check(chatOpen.value.ok === true, 'open(executor=chat) 通过', chatOpen.value.error || '');
  check(chatOpen.value.brief?.length > 0, 'executor=chat 的返回值带 brief 正文');
  check(
    chatOpen.text.length <= 6000,
    `executor=chat 的返回正文 ${chatOpen.text.length} ≤ 6000 字符（handoffBudgetChars）`,
  );
  check(
    chatOpen.text.includes('## 1. 任务卡') && chatOpen.text.includes('## 9. 回执格式'),
    'chat 返回值含完整九节（任务卡 … 回执格式）',
  );
  const chatPrompt = readFileSync(join(chatOpen.value.dir, 'prompt.md'), 'utf8');
  check(/以下是\*\*完整 brief 正文\*\*/.test(chatPrompt), 'chat 的 prompt.md 顶部改成「以下是完整 brief，直接读」');
  check(/向用户索取/.test(chatPrompt), 'chat 的 prompt.md 要求内容被截断时向用户索取 brief.md 全文');
  check(
    !/先完整读这份 brief\.md/.test(chatPrompt),
    'chat 的 prompt.md 不再要求去读本地文件（读不到）',
  );
  const filePrompt = readFileSync(join(dir1, 'prompt.md'), 'utf8');
  check(/先完整读这份 brief\.md/.test(filePrompt), 'executor=file（默认）仍是「读交接目录里的 brief.md」');

  // ── 11. close 的 verifyBuild="stat"：changed/screenshots 落盘校验 ───────────────
  console.log('\n=== 11. close verifyBuild=stat ===');
  const openStat = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关' });
  const statReport = JSON.stringify({
    status: 'done',
    summary: '设置页加了暗色开关',
    changed: [
      { file: 'Kirara_Media/app/src/main/java/com/akeno/kirara/SettingsScreen.kt', why: '加开关' },
      { file: 'Kirara_Media/app/src/main/java/com/akeno/kirara/GhostScreen.kt', why: '其实没这个文件' },
    ],
    screenshots: [{ path: 'shots/ghost.png' }],
    verification: { build: 'ok', uiLoop: 'closed', acceptance: [] },
  });
  const statClose = await call({ action: 'close', runId: openStat.value.runId, report: statReport, verifyBuild: 'stat' });
  check(statClose.value.ok === true, 'stat 校验发现问题时 close 仍然 ok（不整体失败）', statClose.value.error || '');
  const statSaved = readJsonSafe(join(openStat.value.dir, 'report.json'));
  check(
    statSaved?.verification?.dshStat?.changedMissing?.length === 1 &&
      statSaved.verification.dshStat.changedMissing[0].endsWith('GhostScreen.kt'),
    'report.json.verification.dshStat.changedMissing 点名不存在的 changed[].file',
    JSON.stringify(statSaved?.verification?.dshStat?.changedMissing ?? null),
  );
  check(
    statSaved?.verification?.dshStat?.files?.find((f) => f.file.endsWith('SettingsScreen.kt'))?.exists === true,
    'dshStat 也记录了真实存在的那个文件（exists=true）',
  );
  check(
    statSaved?.verification?.dshStat?.screenshotsMissing?.length === 1,
    'dshStat 记录了不存在的截图',
    JSON.stringify(statSaved?.verification?.dshStat?.screenshotsMissing ?? null),
  );
  check(statSaved?.verification?.dshRerun === undefined, 'stat 不跑构建（dshRerun 不出现）');
  check(/校验:/.test(statClose.text) && /缺 1/.test(statClose.text), '渲染里给出 stat 警告', statClose.text.split('\n').find((l) => /校验:/.test(l)) || '');
  check(
    (statClose.value.openIssues || []).some((s) => /DSH stat/.test(s)),
    '差异同时写进 openIssues（下一步读得到）',
    (statClose.value.openIssues || []).join(' | '),
  );

  // ── 12. close 的 verifyBuild="rerun"：真跑一次构建并比对回执自述 ────────────────
  console.log('\n=== 12. close verifyBuild=rerun（假 gradlew）===');
  const okReport = JSON.stringify({
    status: 'done',
    summary: '设置页加了暗色开关，构建已跑',
    changed: [{ file: 'Kirara_Media/app/src/main/java/com/akeno/kirara/SettingsScreen.kt', why: '加开关' }],
    verification: { build: 'ok', uiLoop: 'closed', acceptance: [] },
  });
  const openRerun = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关' });
  const rerun = await call({ action: 'close', runId: openRerun.value.runId, report: okReport, verifyBuild: 'rerun' });
  const rerunSaved = readJsonSafe(join(openRerun.value.dir, 'report.json'));
  check(rerun.value.ok === true, 'rerun 的 close 通过', rerun.value.error || '');
  const run0 = rerunSaved?.verification?.dshRerun?.[0];
  check(
    run0?.project === 'media' && run0.ok === true && run0.exitCode === 0 && typeof run0.durationMs === 'number',
    'report.json.verification.dshRerun 记录了 media 的 ok / exitCode / 耗时',
    JSON.stringify(run0 ?? null),
  );
  check(/复跑: media ok/.test(rerun.text), '渲染里给出复跑结果', rerun.text.split('\n').find((l) => /复跑:/.test(l)) || '');
  check(
    rerunSaved?.verification?.dshRerunMismatch === undefined,
    '自述与复跑一致时不写 mismatch',
    JSON.stringify(rerunSaved?.verification?.dshRerunMismatch ?? null),
  );

  // 构建失败 + 回执自述 ok ⇒ close 仍然成功落账，但差异进 openIssues / nextStep
  writeFakeGradle(1);
  const openFail = await call({ action: 'open', request: '给安卓端设置页加一个暗色模式开关' });
  const failClose = await call({ action: 'close', runId: openFail.value.runId, report: okReport, verifyBuild: 'rerun' });
  const failSaved = readJsonSafe(join(openFail.value.dir, 'report.json'));
  check(failClose.value.ok === true, '构建失败也**不**让 close 整体失败（仍然落账）', failClose.value.error || '');
  check(
    failSaved?.verification?.dshRerun?.[0]?.ok === false && failSaved.verification.dshRerun[0].exitCode === 1,
    'report.json 如实记录复跑失败（ok=false / exitCode=1）',
    JSON.stringify(failSaved?.verification?.dshRerun?.[0] ?? null),
  );
  check(
    (failClose.value.openIssues || []).some((s) => /不一致/.test(s)),
    '「回执自述 build 与 DSH 复跑不一致」写进 openIssues',
    (failClose.value.openIssues || []).join(' | '),
  );
  check(/不一致/.test(failClose.value.nextStep || ''), 'nextStep 也明说不一致', failClose.value.nextStep?.slice(0, 120));
  check(failClose.text.length <= 2400, `close(rerun, 失败) 返回正文 ${failClose.text.length} ≤ 2400 字符`);
  writeFakeGradle(0);

  // 默认 verifyBuild=off：一个构建都不该跑（dshStat/dshRerun 都不出现）
  check(savedReport?.verification?.dshStat === undefined, '默认 verifyBuild=off 不写 dshStat（现状不变）');

  // ── 13. kirara_profile 的死链自检 ──────────────────────────────────────────
  console.log('\n=== 13. kirara_profile 死链自检 ===');
  const cleanProfile = await callNamed('kirara_profile', { project: 'media' });
  check(
    !/失效文档路径/.test(cleanProfile.text),
    '文档都在时**不**输出 ⚠️ 行（零成本）',
    cleanProfile.text.split('\n').filter((l) => /失效/.test(l)).join(' | ') || '(无)',
  );
  const iosReadme = join(media, 'iosApp', 'README.md');
  rmSync(iosReadme, { force: true });
  const dirtyProfile = await callNamed('kirara_profile', { project: 'media' });
  check(/⚠️ 失效文档路径（1）/.test(dirtyProfile.text), '登记了不存在的文档时追加 ⚠️ 行', dirtyProfile.text.split('\n').filter((l) => /失效/.test(l)).join(' | '));
  check(
    /iosApp\/README\.md/.test(dirtyProfile.text),
    '⚠️ 行点名了那条失效路径（相对仓库根）',
    (dirtyProfile.value.docIssues || []).join(', '),
  );
  check(/请更新 PROJECTS/.test(dirtyProfile.text), '⚠️ 行给出可操作的下一步（更新 PROJECTS）');
  writeFileSync(iosReadme, '# iosApp\n', 'utf8');
} finally {
  // 结束时清掉临时工作区；失败时同样清（错误信息已经打印在上面）。
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('');
if (failures) {
  console.log(`✗ 交接夹具失败 ${failures} 项`);
  process.exit(1);
}
console.log('✅ 外部交接夹具通过：九节齐全、预算内、回执校验严格、路径不越界');
