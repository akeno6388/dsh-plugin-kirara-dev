/**
 * 前缀缓存回归夹具。
 *
 * 为什么需要它：这个插件对 DSH 前缀缓存的全部影响面只有两处，而且都能被机器检查 ——
 *   ① 工具集合 / description / parameters 必须是**随启动固定的字面量**。DSH 把
 *      request/header（config + tools 的 JSON 快照）记进会话，工具集合或工具描述只要
 *      与已记录的快照不一致，dsh-agent-loop 就会开一条新的 request series，而
 *      SystemPromptProjection 在 startsSeries 时是**原地改写**对话第一条 system 消息
 *      —— 整段前缀缓存作废。
 *   ② 每个工具的返回值必须**有硬预算**。返回值会永久留在会话上下文里，上下文越大越早
 *      触发 compaction，而每次 compaction 同样会重写历史头部、作废整段前缀。
 *
 * 用法：node scripts/cache-budget.mjs
 * 退出码 0 = 全部预算与稳定性断言通过。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginPath = new URL('../lib/index.js', import.meta.url).href;

/**
 * 三端仓库的父目录 —— 也就是插件真正要吃的那棵树。
 * 本文件在 <workspace>/dsh-plugin-kirara-dev/scripts/ 下，所以上两级就是 workspace。
 * 指错地方的代价是 kirara_docs 扫不到任何文档，预算测量会退化成空跑。
 */
const WORKSPACE_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '');

/**
 * 预算常量（有意写死在这里，而不是从插件里 import）：
 * 这些是「回归基线」，改动插件默认值时必须显式改这里，否则夹具会替你发现。
 *
 * 实测基线（canonical 形状 = name+description+parameters，与 DSH 记进 request/header 的一致）：
 *   修订前 2026-10-10：7 个工具合计 6326 字节，全部滞留在每次请求的前缀里。
 *   修订后：5061 字节。卡在 5400 是为了抓回归 —— 描述重新写胖就会红。
 */
const BUDGET = {
  /** 7 个工具的 name+description+parameters JSON 总字节上限。 */
  toolSchemaBytes: 5400,
  /** kirara_docs 单次 render 的字符上限（插件默认 docsBudgetChars=4000 + 截断提示）。 */
  docsRenderChars: 4400,
  /** kirara_build 单次 render 的字符上限（buildBudgetChars=5000 + 头部状态行）。 */
  buildRenderChars: 5600,
  /** kirara_start 单次 render 的字符上限（实测最坏情况：长需求 + full ≈ 1221）。 */
  startRenderChars: 1400,
  /** kirara_verify full 单次 render 的字符上限。 */
  verifyRenderChars: 2000,
  /** 叙述型工具（start/route/profile/verify/summary）的硬预算 textBudgetChars。 */
  narrativeHardCap: 1600,
};

/** 不应出现在 description/parameters 里的「每台机器/每次启动都不一样」的东西。 */
const VOLATILE_PATTERNS = [
  [/\b20\d\d-\d\d-\d\d\b/, '日期字面量'],
  [/\b\d\d:\d\d:\d\d\b/, '时刻字面量'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'UUID'],
  [/\b1[6-9]\d{11}\b/, 'epoch 毫秒'],
  [/\$\{?(now|Date\.now|timestamp)/i, '运行时取时间'],
  [/[A-Za-z]:\\/, '绝对盘符路径'],
  [/\bDSH_WORKSPACE\b|\bprocess\.env\b/, '环境变量引用'],
];

const failures = [];
const bad = (msg, detail) => {
  failures.push(msg);
  console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`);
};
const ok = (msg, detail) => console.log(`  ✓ ${msg}${detail ? `\n      ${detail}` : ''}`);

/** 用假 ctx 跑一次 apply，拿回注册结果（与 scripts/selftest.mjs 同一套夹具思路）。 */
async function register(root = WORKSPACE_ROOT) {
  const mod = await import(pluginPath);
  const live = new Map();
  const canonical = new Map();
  const ctx = {
    tools: {
      register(tool) {
        if (!tool || typeof tool.name !== 'string') throw new Error('register 收到非法 tool');
        if (live.has(tool.name)) throw new Error(`重复注册: ${tool.name}`);
        live.set(tool.name, tool);
        // DSH 记进 request/header 的 canonical tool schema 只有 name/description/parameters
        // （见 dsh-system-prompt 的 assemble()：schemas.map(({name, description, parameters}) => ...)）。
        // 所以字节预算必须按这个形状度量，而不是按整个 defineTool 对象。
        canonical.set(tool.name, JSON.parse(JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })));
        // 真实 DSH 里 register 返回 effect disposer；夹具返回同样的形状。
        return () => { live.delete(tool.name); canonical.delete(tool.name); };
      },
    },
  };
  const config = { workspaceRoot: root, buildTimeoutMs: 1200000 };
  mod.apply(ctx, config);
  return { live, canonical };
}

function exec(live, name, args) {
  const t = live.get(name);
  const value = t.execute(args, { agent: null });
  return Promise.resolve(value).then((v) => ({
    value: v,
    text: (t.output.render ? t.output.render(args, v) : []).map((b) => b.text ?? '').join(''),
  }));
}

console.log('=== 1. 工具集合与 schema 字面量稳定性 ===');
const run1 = await register();
const run2 = await register();
const first = run1.canonical;
const firstLive = run1.live;

const names = [...first.keys()].sort();
console.log(`  已注册 ${names.length} 个工具：${names.join(', ')}`);

const EXPECTED = ['kirara_build', 'kirara_docs', 'kirara_profile', 'kirara_route', 'kirara_start', 'kirara_summary', 'kirara_verify'];
const missing = EXPECTED.filter((n) => !first.has(n));
const extra = names.filter((n) => !EXPECTED.includes(n));
if (missing.length || extra.length) {
  bad('工具集合与名义集合不一致（会让 DSH 开新 request series 并作废整段前缀缓存）',
    `缺失=[${missing.join(', ')}] 多出=[${extra.join(', ')}]`);
} else {
  ok('工具集合与名义集合一致', `7 个：${names.join(', ')}`);
}

// 两次独立加载必须逐字节一致：只要描述里有任何「跑起来才知道」的内容，这里就会红。
const snap1 = JSON.stringify(names.map((n) => first.get(n)));
const snap2 = JSON.stringify(names.map((n) => run2.canonical.get(n)));
if (snap1 !== snap2) {
  bad('两次独立加载的 canonical tool schema 快照不一致（工具目录抖动 ⇒ 前缀缓存作废）');
} else {
  ok('两次独立加载的 canonical tool schema 逐字节一致', `${snap1.length} 字节`);
}

const schemaBytes = names.reduce((a, n) => a + JSON.stringify(first.get(n)).length, 0);
const descBytes = names.reduce((a, n) => a + first.get(n).description.length, 0);
if (schemaBytes > BUDGET.toolSchemaBytes) {
  bad(`canonical 工具 schema 总字节 ${schemaBytes} 超出预算 ${BUDGET.toolSchemaBytes}`,
    `description 合计 ${descBytes} 字节。工具 schema 每次请求都在前缀里，且每轮都计入压缩阈值。`);
} else {
  ok(`canonical 工具 schema 总字节 ${schemaBytes} ≤ ${BUDGET.toolSchemaBytes}`, `其中 description 合计 ${descBytes} 字节`);
}

console.log('\n  逐个工具的字节数（canonical 形状 = name+description+parameters）：');
for (const n of names) {
  const t = first.get(n);
  console.log(`    ${n.padEnd(16)} schema=${String(JSON.stringify(t)).length.toString().padStart(5)}  description=${String(t.description.length).padStart(4)}`);
}

console.log('\n=== 2. description / parameters 不含易变内容 ===');
for (const n of names) {
  const t = first.get(n);
  const hay = `${t.description}\n${JSON.stringify(t.parameters)}`;
  const hits = VOLATILE_PATTERNS.filter(([re]) => re.test(hay)).map(([, label]) => label);
  if (hits.length) bad(`${n} 的 description/parameters 含易变内容：${hits.join('、')}`);
}
if (!failures.some((f) => f.includes('易变内容'))) {
  ok('没有发现日期/时刻/UUID/epoch/环境变量/绝对路径等易变内容');
}

console.log('\n=== 3. 各工具单次 render 的字符预算 ===');
const checks = [
  // 关键词故意选宽泛词，逼近最坏情况
  ['kirara_docs（宽泛关键词，最坏情况）', 'kirara_docs', { keywords: ['服务', '接口', '实例', '主题'] }, BUDGET.docsRenderChars],
  ['kirara_docs（maxHits 拉满 40）', 'kirara_docs', { keywords: ['a', 'e', 's'], maxHits: 40 }, BUDGET.docsRenderChars],
  ['kirara_start（长需求 + full）', 'kirara_start', {
    request: '删掉旧的评论表并重构为分表存储，同时把设置页的登录迁移到新 API，需要改表结构与索引，并调整首页与详情页的交互与配色',
    mode: 'full',
  }, BUDGET.startRenderChars],
  ['kirara_verify（full）', 'kirara_verify', { summary: '设置页加暗色开关', project: 'desktop', mode: 'full' }, BUDGET.verifyRenderChars],
  ['kirara_profile（三端全量）', 'kirara_profile', {}, 1200],
  ['kirara_route（full + 阻塞）', 'kirara_route', { request: '删除旧的评论表并重构为分表存储，需要改表结构', mode: 'full' }, 1500],
  ['kirara_summary', 'kirara_summary', { feature: 'x', mode: 'full', changes: ['a', 'b'], builds: ['c'], risks: ['d'] }, 800],
];
for (const [label, name, args, budget] of checks) {
  if (!firstLive.has(name)) { bad(`${label}: 工具未注册`); continue; }
  const { value, text } = await exec(firstLive, name, args);
  if (text.length > budget) {
    bad(`${label}: render ${text.length} 字符超出预算 ${budget}`);
  } else {
    ok(`${label}: ${text.length} ≤ ${budget} 字符`);
  }
  // workspaceRoot 指错时 kirara_docs 扫不到任何文档，docs 预算就只是空跑。
  if (name === 'kirara_docs' && (value.hits?.length ?? 0) === 0) {
    console.log(`      ⚠️ 本次 0 命中 —— 文档预算未被真正压到（workspaceRoot=${WORKSPACE_ROOT}，扫描 ${value.scannedFiles} 个文件）`);
  }
}

console.log('\n=== 4. 叙述型工具的硬预算（异常大入参也不许灌爆上下文） ===');
{
  // kirara_summary 的入参完全由模型给：把 200 条变更塞进去，未设预算时 render 会到 ~10 KB。
  const huge = Array.from({ length: 200 }, (_, i) => `变更条目 ${i} —— `.padEnd(60, 'x'));
  const cases = [
    ['kirara_summary', { feature: 'x'.repeat(500), mode: 'full', changes: huge, builds: huge, risks: huge }],
    ['kirara_route', { request: 'x'.repeat(4000), mode: 'full' }],
    ['kirara_start', { request: 'x'.repeat(4000), mode: 'full' }],
    ['kirara_verify', { summary: 'x'.repeat(4000), project: 'desktop', mode: 'full' }],
  ];
  for (const [name, args] of cases) {
    const { text } = await exec(firstLive, name, args);
    const cap = BUDGET.narrativeHardCap + 200; // + 截断提示的固定开销
    if (text.length > cap) {
      bad(`${name}: 超大入参下 render ${text.length} 字符，超出硬预算 ${BUDGET.narrativeHardCap}(+提示)`);
    } else {
      ok(`${name}: 超大入参下 render ${text.length} ≤ ${cap} 字符`);
    }
    if (text.length > BUDGET.narrativeHardCap && !/截断/.test(text)) {
      bad(`${name}: 被硬预算截断但没有说明`);
    }
  }
}

console.log('\n=== 5. kirara_docs 截断提示必须可操作 ===');
{
  // 不传 maxHits，检查插件自己的默认值（docsMaxHits，默认 12）。
  const { value, text } = await exec(firstLive, 'kirara_docs', { keywords: ['服务', '接口'] });
  if (value.hits.length > 12) {
    bad(`kirara_docs 未按 docsMaxHits=12 收口：返回 ${value.hits.length} 行`);
  } else {
    ok(`kirara_docs 默认命中行数已收口：${value.hits.length} ≤ 12`);
  }
  if (value.truncated && !/收窄/.test(text)) {
    bad('kirara_docs 截断时没有告诉模型怎么收窄查询');
  } else {
    ok('kirara_docs 截断时会给出收窄建议（或本次未截断）');
  }
}

console.log('\n=== 6. kirara_build 的日志硬预算（临时假工程，200 行 × 每行 400 字符） ===');
{
  // 未设预算时这一节会产出 ~80 KB 输出 —— 正是实测里单次 kirara_build 塞进 16.8 KB 的成因。
  const tmp = await mkdtemp(join(tmpdir(), 'kirara-budget-'));
  try {
    const media = join(tmp, 'Kirara_Media');
    await mkdir(media, { recursive: true });
    const noise = 'X'.repeat(400);
    const lines = Array.from({ length: 200 }, (_, i) => `echo ${i}-${noise}`);
    await writeFile(join(media, 'gradlew.bat'), `@echo off\r\n${lines.join('\r\n')}\r\nexit /b 0\r\n`);

    const run = await register(tmp);
    const { value, text } = await exec(run.live, 'kirara_build', { project: 'media' });

    if (text.length > BUDGET.buildRenderChars) {
      bad(`kirara_build: render ${text.length} 字符超出预算 ${BUDGET.buildRenderChars}`);
    } else {
      ok(`kirara_build: render ${text.length} ≤ ${BUDGET.buildRenderChars} 字符`, '原始输出约 80 KB，已按预算收敛');
    }
    if (value.logTail.length > 5200) {
      bad(`kirara_build: logTail ${value.logTail.length} 字符未被 buildBudgetChars=5000 收口`);
    } else {
      ok(`kirara_build: logTail ${value.logTail.length} ≤ ~5000 字符`);
    }
    const longest = value.logTail.split('\n').reduce((a, l) => Math.max(a, l.length), 0);
    if (longest > 330) {
      bad(`kirara_build: 单行仍有 ${longest} 字符（buildLogLineChars=300 未生效）`);
    } else {
      ok(`kirara_build: 最长行 ${longest} ≤ ~300 字符（逐行截断生效）`);
    }
    if (!/截断/.test(value.logTail)) {
      bad('kirara_build: logTail 被截断但没有说明（模型会以为自己看到了完整日志）');
    } else {
      ok('kirara_build: 截断说明已附在 logTail 里');
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

console.log('');
if (failures.length) {
  console.log(`❌ 缓存预算回归未通过：${failures.length} 项`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log('✅ 缓存预算回归通过：工具目录稳定，输出都有硬预算');
