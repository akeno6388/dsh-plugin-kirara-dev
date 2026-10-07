/**
 * 真实宿主契约测试 —— 走 DSH **自己的**注册/调度链路，不用假 ctx。
 *
 * 为什么需要它：`selftest.mjs` 用假 `ctx.tools.register` 只证明「工具函数能跑」，
 * 从不经过宿主的 `ToolRuntime`。2026-10 的事故恰好就在那条路上：插件把宿主包声明成
 * `dependencies`，pnpm 把 `@deepseek-ai/dsh-tools` 铺进 profile，宿主于是加载了第二份
 * `dsh-tools` 副本 —— `TOOL_RUNTIME_SCHEDULER` 是两个不同的 Symbol，
 * `ctx.tools[SYMBOL].prepare(...)` 得到 `undefined`，**所有**工具调用（含内置 read/pwsh）
 * 都崩在 `Cannot read properties of undefined (reading 'prepare')`。
 *
 * 这个脚本做四件事：
 *   1. 用宿主安装目录那一份 `dsh-tools`（经模块拦截钩子，语义等同 app-boot 的
 *      `routeScoped`）构造**真实** cordis `Context` + **真实** `ToolRuntime`；
 *   2. 把插件 `apply()` 挂上去，逐个 `prepare()` 七个工具，证明调度器存在且可派发；
 *   3. 对 `kirara_profile` 跑完整 `prepare → dispatch → finish`，证明结果真的产出；
 *   4. 断言「宿主作用域内不存在第二个物理副本」（模块身份唯一）。
 *
 * 用法：
 *   node scripts/contract-test.mjs                     # 优先测 profile 里已部署的副本
 *   node scripts/contract-test.mjs --from source       # 测源码树
 *   node scripts/contract-test.mjs --host <node_modules 绝对路径>   # 显式指定宿主包目录
 *
 * 退出码 0 = 契约成立；1 = 有断言失败。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
};

let failures = 0;
const ok = (label, detail) => console.log(`  ✓ ${label}${detail ? `\n      ${detail}` : ''}`);
const bad = (label, detail) => {
  failures += 1;
  console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
};
const check = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail));

// ── 0. 选定被测插件入口与宿主包目录 ─────────────────────────────────────────
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', process.env.DSH_PROFILE || 'desktop');
const deployedDir = join(profileDir, 'node_modules', '@kirara', 'dsh-plugin-kirara-dev');
const wantSource = args.includes('--from') && flagValue('--from') === 'source';
const useDeployed = !wantSource && existsSync(join(deployedDir, 'lib', 'index.js'));
const pluginRoot = useDeployed ? deployedDir : pluginDir;

const hostRoot = flagValue('--host') ?? process.env.DSH_HOST_NODE_MODULES ?? join(pluginDir, 'node_modules');
console.log('=== 被测对象 ===');
console.log(`  插件入口 : ${join(pluginRoot, 'lib', 'index.js')}（${useDeployed ? 'profile 已部署副本' : '源码树'}）`);
console.log(`  宿主包目录: ${hostRoot}`);

if (!existsSync(join(hostRoot, '@deepseek-ai', 'dsh-tools', 'package.json'))) {
  console.error(`  ✗ 宿主包目录里没有 @deepseek-ai/dsh-tools：${hostRoot}`);
  console.error('    用 --host 指向一个含宿主包安装的 node_modules 目录。');
  process.exit(2);
}
const hostToolsVersion = JSON.parse(readFileSync(join(hostRoot, '@deepseek-ai', 'dsh-tools', 'package.json'), 'utf8')).version;

// ── 1. 装上「宿主拦截层」钩子（等价 app-boot 的 routeScoped 拦截语义） ────────
process.env.DSH_HOST_NODE_MODULES = hostRoot;
register('./host-interception.mjs', import.meta.url);
console.log(`\n=== 1. 宿主模块拦截层 ===`);
console.log(`  已注册解析钩子；宿主 dsh-tools 版本 = ${hostToolsVersion}`);

const cordisUrl = pathToFileURL(join(hostRoot, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href;
const toolsUrl = pathToFileURL(join(hostRoot, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href;
const { Context } = await import(cordisUrl);
const { ToolRuntime, TOOL_RUNTIME_SCHEDULER } = await import(toolsUrl);

// ── 2. 真实 Context + 真实 ToolRuntime ──────────────────────────────────────
console.log('\n=== 2. 真实 cordis Context + ToolRuntime ===');
const ctx = new Context();
ctx.provide('systemPrompt', {
  tools() {},
  section() {},
  getSectionOrder() {
    return 0;
  },
});
const runtime = new ToolRuntime(ctx, { mode: 'native' });
check(typeof ctx.tools === 'object' && ctx.tools !== null, 'ToolRuntime 已作为 ctx.tools 服务挂载');
const scheduler = runtime[TOOL_RUNTIME_SCHEDULER];
check(scheduler !== undefined && typeof scheduler.prepare === 'function', 'TOOL_RUNTIME_SCHEDULER 可解析且带 prepare()', '这正是事故里为 undefined 的那个查表结果');

// ── 3. 加载插件并 apply ─────────────────────────────────────────────────────
console.log('\n=== 3. 加载插件并 apply() ===');
const pluginUrl = pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href;
const plugin = await import(pluginUrl);
check(typeof plugin.apply === 'function', `插件导出 apply()（name=${plugin.name}）`);

const config = {
  workspaceRoot: 'D:\\works\\Kirara Server Project',
  buildTimeoutMs: 1200000,
  buildLogTailLines: 60,
};
try {
  plugin.apply(ctx, config);
  ok('apply(ctx, config) 未抛异常');
} catch (error) {
  bad('apply(ctx, config) 抛异常', error?.message);
  console.log(error?.stack?.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}

/** 从真实 ToolRuntime 取回定义（不同小版本内部结构不同，多路兜底）。 */
function lookup(name) {
  if (typeof runtime.get === 'function') {
    const found = runtime.get(name);
    if (found) return found;
  }
  const collection = runtime.layers?.global?.tools;
  if (collection && typeof collection.get === 'function') {
    const found = collection.get(name);
    if (found) return found;
  }
  return undefined;
}

const TOOL_NAMES = ['kirara_start', 'kirara_profile', 'kirara_docs', 'kirara_route', 'kirara_build', 'kirara_verify', 'kirara_summary'];
const definitions = new Map();
for (const name of TOOL_NAMES) {
  const def = lookup(name);
  if (def) definitions.set(name, def);
}
check(definitions.size === TOOL_NAMES.length, `真实 ToolRuntime 里找到全部 ${TOOL_NAMES.length} 个 kirara_* 定义`, definitions.size === TOOL_NAMES.length ? [...definitions.keys()].join(', ') : `只找到 ${definitions.size} 个：${[...definitions.keys()].join(', ') || '(无)'}`);

// ── 4. 每个工具过一遍真实调度器 prepare() ────────────────────────────────────
/** 按 JSON Schema 给必填参数造一个合法样本值。 */
function sampleFor(name, schema) {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 1;
  if (schema.type === 'string') {
    if (/project/.test(name)) return 'api';
    if (/mode/.test(name)) return 'auto';
    if (/feature|title/.test(name)) return '契约测试';
    return '契约测试请求：给设置页加一个暗色模式开关';
  }
  return undefined;
}
function sampleArgs(def) {
  const out = {};
  const params = def.parameters ?? {};
  const required = Array.isArray(params.required) ? params.required : Object.keys(params.required ?? {});
  for (const key of required) {
    const value = sampleFor(key, params.properties?.[key] ?? {});
    if (value !== undefined) out[key] = value;
  }
  return out;
}

console.log('\n=== 4. 真实调度器 prepare()（每个工具） ===');
for (const [name, def] of definitions) {
  const exec = { callId: `contract-${name}`, name, arguments: sampleArgs(def), signal: new AbortController().signal };
  try {
    const prepared = await scheduler.prepare(exec);
    if (prepared?.kind === 'dispatch' && prepared.exec?.name === name) {
      ok(`${name}: prepare → dispatch`, `arguments = ${JSON.stringify(prepared.exec.arguments)}`);
    } else {
      bad(`${name}: prepare 未返回可派发执行`, `kind=${prepared?.kind} result=${JSON.stringify(prepared?.result?.content?.[0]?.text ?? '')}`);
    }
  } catch (error) {
    bad(`${name}: prepare 抛异常`, error?.message);
  }
}

// ── 5. presentCall 视图（客户端渲染用的那份） ────────────────────────────────
console.log('\n=== 5. presentCall() 视图形状 ===');
const CALL_KINDS = new Set(['read', 'execute', 'other', 'search', 'write', 'network', 'plan', 'edit']);
for (const [name, def] of definitions) {
  if (typeof def.presentCall !== 'function') {
    bad(`${name}: 缺 presentCall`, 'defineTool 未挂上 presentCall（声明缺失或被软校验吞掉）');
    continue;
  }
  const view = def.presentCall(sampleArgs(def));
  if (view === undefined) {
    bad(`${name}: presentCall 返回 undefined`, '说明 defineTool 的软校验判定参数不合法');
    continue;
  }
  const problems = [];
  if (view.card !== 'generic') problems.push(`card=${view.card}`);
  if (typeof view.title !== 'string' || view.title.length === 0) problems.push('title 缺失');
  if (!CALL_KINDS.has(view.kind)) problems.push(`kind=${view.kind} 不在 ToolCallKind 内`);
  check(problems.length === 0, `${name}: 视图合法`, problems.length ? problems.join('; ') : `${JSON.stringify(view).slice(0, 96)}`);
}

// ── 6. 完整链路：prepare → dispatch → finish（只读工具） ─────────────────────
console.log('\n=== 6. 完整链路 prepare → dispatch → finish（kirara_profile） ===');
try {
  const prepared = await scheduler.prepare({
    callId: 'contract-profile-full',
    name: 'kirara_profile',
    arguments: {},
    signal: new AbortController().signal,
  });
  check(prepared?.kind === 'dispatch', 'dispatch 前检查通过');
  const dispatched = await scheduler.dispatch(prepared.exec);
  const finished = await scheduler.finish(prepared.exec, dispatched.result);
  const text = (finished.content ?? []).map((block) => block.text ?? '').join('\n');
  check(finished.isError !== true, '工具体执行成功（isError 非 true）', `content blocks = ${finished.content?.length ?? 0}`);
  check(text.length > 0, '产出非空文本内容');
  console.log('      ── 前 12 行 ──');
  for (const line of text.split('\n').slice(0, 12)) console.log(`      ${line}`);
} catch (error) {
  bad('完整链路段抛异常', error?.message);
  console.log(error?.stack?.split('\n').slice(0, 8).join('\n'));
}

// ── 6.5 工具返回值必须过宿主的 lossless JSON 边界 ─────────────────────────────
// 事故（2026-10-05，由 DSH 侧实测反馈驱动）：`kirara_build` 三端里两端从未可用过。
// 返回对象里 `artifact` 恒为 `undefined` —— api/desktop 的项目画像没有 `apk` 字段，
// media 在 APK 不存在时也保持 undefined；`exitCode: r.code ?? undefined` 在超时/启动
// 失败时（`code` 为 null）同样是 undefined。
//
// 宿主侧两道关都拒它（实测 @deepseek-ai/dsh-util-values 的 walkJsonValue）：
//   · snapshotJsonValue({x: undefined}) === undefined（对象分支逐键 visit，undefined 落到
//     `typeof current !== "object"` 一行直接判负）；
//   · 即便绕过快照，schema 层也会补一句 `"value" must be a lossless JSON object`。
// 用户看到的是 `tool "kirara_build" returned invalid output` —— 像 harness 故障，
// 实际是插件返回值违规。
//
// 为什么之前没抓到：§6 只对 kirara_profile 跑了完整 dispatch，而 kirara_profile 的返回值
// 恰好干净。夹具此前只检查 `prepare()` 的形状，从不检查**返回值**。
// 这一节把 7 个工具全部真派发一次（临时空 root，毫秒级），外加 kirara_build 的两种退出码。
console.log('\n=== 6.5 工具返回值 lossless JSON 边界（7 个工具真派发） ===');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { isJsonValue, snapshotJsonValue } = await import(pathToFileURL(join(hostRoot, '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js')).href);

const tempRoot = mkdtempSync(join(tmpdir(), 'kirara-contract-'));
const fakeMedia = join(tempRoot, 'Kirara_Media');
mkdirSync(fakeMedia, { recursive: true });
const savedWorkspaceRoot = config.workspaceRoot;
config.workspaceRoot = tempRoot; // resolveRoot 每次现读，所以改这个引用即可

/** 派发的统一出口：把宿主抛出的校验失败也变成可断言的数据。 */
const dispatchTool = async (name, toolArgs) => {
  const prepared = await scheduler.prepare({
    callId: `contract-out-${name}`,
    name,
    arguments: toolArgs,
    signal: new AbortController().signal,
  });
  if (prepared?.kind !== 'dispatch') return { stage: 'prepare', prepared };
  try {
    const dispatched = await scheduler.dispatch(prepared.exec);
    const finished = await scheduler.finish(prepared.exec, dispatched.result);
    return { stage: 'done', finished };
  } catch (error) {
    return { stage: 'threw', error };
  }
};

/** 判定一次派发结果：宿主拒收时会是一个 isError 结果，正文带 invalid output / lossless JSON。 */
const inspectOutcome = (name, outcome) => {
  if (outcome.stage === 'prepare') return `prepare 未放行（kind=${outcome.prepared?.kind}）`;
  if (outcome.stage === 'threw') return `抛异常：${outcome.error?.message ?? outcome.error}`;
  const text = (outcome.finished?.content ?? []).map((block) => block?.text ?? '').join('\n');
  if (/returned invalid output|not lossless JSON|non-lossless JSON/.test(text)) {
    return `宿主拒收返回值：${text.split('\n').slice(0, 3).join(' / ')}`;
  }
  const blocks = outcome.finished?.content ?? [];
  const unserializable = blocks.filter((block) => snapshotJsonValue({ text: block?.text ?? null, type: block?.type ?? null }) === undefined);
  if (unserializable.length > 0) return `${unserializable.length} 个 content block 不是 lossless JSON`;
  return undefined; // 干净
};

try {
  // (a) 7 个工具全覆盖。kirara_build 单独在 (b) 里测（它的 sampleArgs 会真跑 dotnet，必须换掉）。
  for (const name of TOOL_NAMES) {
    if (name === 'kirara_build') continue;
    const outcome = await dispatchTool(name, sampleArgs(definitions.get(name)));
    const problem = inspectOutcome(name, outcome);
    check(problem === undefined, `${name}: 返回值可被宿主接受`, problem ?? `isError=${outcome.finished?.isError}`);
  }

  // (b) kirara_build：假 gradlew.bat + 临时 root —— 「构建完成但没有产物」是 media 的真实失败面，
  //     也是 artifact 变 undefined 的那条路。不碰任何真实工具链。
  for (const [label, exitCode, title] of [
    [`build-ok-${0}`, 0, 'kirara_build 构建成功但无 APK'],
    [`build-fail-${3}`, 3, 'kirara_build 构建失败且无 APK'],
  ]) {
    writeFileSync(join(fakeMedia, 'gradlew.bat'), `@echo off\r\nexit /b ${exitCode}\r\n`);
    const outcome = await dispatchTool('kirara_build', { project: 'media' });
    const problem = inspectOutcome('kirara_build', outcome);
    if (problem !== undefined) {
      bad(`${title}: 返回值为 lossless JSON`, `${problem}\n      ← 可选键（exitCode / artifact）必须用条件展开省略，不能写成 undefined。`);
      continue;
    }
    // 可选键被省略后，render 必须退化成 n/a 而不是把 undefined 抖给用户看。
    const statusLine = (outcome.finished?.content?.[0]?.text ?? '').split('\n')[0];
    if (/undefined/.test(statusLine)) {
      bad(`${title}: 状态行不得出现 undefined 字样`, statusLine);
      continue;
    }
    ok(`${title}: 返回值为 lossless JSON`, `exit=${exitCode}、无产物 ⇒ artifact 必须省略而不是 undefined；状态行：${statusLine.slice(0, 72)}`);
  }

  // (c) kirara_verify 的 full 分支：必须真派发走一遍。
  //     事故（2026-10-05 DSH 实测）：`execute` 末尾写成 `{ ..., screenshotReview }`，
  //     无 screenshots 时该键为 **显式 undefined** ⇒ 宿主拒收
  //     `tool "kirara_verify" returned invalid output`。此前 (a) 虽然也派发了
  //     kirara_verify，却覆盖不到：`sampleFor` 给 mode 造的是 'auto'，而协议生成与否
  //     只取决于 screenshots —— 参数恰好绕开了出问题的那条分支。所以这里显式补两种入参。
  for (const [title, verifyArgs] of [
    ['kirara_verify full 无截图（screenshotReview 必须整体省略）', { summary: '契约测试：无截图', project: 'media', mode: 'full' }],
    ['kirara_verify full 带截图（screenshotReview 应出现）', { summary: '契约测试：带截图', project: 'media', mode: 'full', screenshots: [import.meta.filename] }],
  ]) {
    const outcome = await dispatchTool('kirara_verify', verifyArgs);
    const problem = inspectOutcome('kirara_verify', outcome);
    if (problem !== undefined) {
      bad(`${title}: 返回值为 lossless JSON`, `${problem}\n      ← 无截图时 screenshotReview 必须条件展开省略，不能写成 undefined。`);
      continue;
    }
    const text = (outcome.finished?.content ?? []).map((block) => block?.text ?? '').join('\n');
    if (/\bundefined\b/.test(text)) {
      bad(`${title}: 正文不得出现 undefined 字样`, text.split('\n').slice(0, 3).join(' / '));
      continue;
    }
    const hasReview = text.includes('截图复核协议');
    const wantReview = verifyArgs.screenshots !== undefined;
    if (hasReview !== wantReview) {
      bad(`${title}: 截图协议出现时机不对`, `传了 screenshots ⇒ 应有协议；实际 hasReview=${hasReview}`);
      continue;
    }
    ok(`${title}: 通过`, `协议段 ${hasReview ? '已出现' : '已省略'}，正文无 undefined`);
  }

  // (d) kirara_start 不得把「交互功能」悄悄降级成 small（免实机验证）。
  //     事故（2026-10-05 实测）：「评论支持 @ 提醒」不含任何外观词，被判 small ——
  //     可 @ 提醒的正文就是评论框里的 @ 选择器，构建通过 ≠ 提醒链路正确。
  for (const [title, request] of [
    ['@ 提及类请求', '评论支持 @ 提醒'],
    ['评论交互类请求', '给评论区加一个回复按钮'],
  ]) {
    const outcome = await dispatchTool('kirara_start', { request });
    const problem = inspectOutcome('kirara_start', outcome);
    if (problem !== undefined) {
      bad(`kirara_start ${title}: 返回值为 lossless JSON`, problem);
      continue;
    }
    const text = (outcome.finished?.content ?? []).map((block) => block?.text ?? '').join('\n');
    const smallDowngrade = /mode=small/.test(text);
    if (smallDowngrade) {
      bad(`kirara_start ${title}: 交互功能被降级为 small`, `构建通过 ≠ 效果正确，应判 full；正文：${text.split('\n').slice(0, 2).join(' / ')}`);
      continue;
    }
    ok(`kirara_start ${title}: 未降级为 small`, text.split('\n')[1]?.slice(0, 88));
  }

  // (e) 静态审计：源码里不得出现「显式赋 undefined」的返回字段。
  //     上面是运行时覆盖，这里兜住没被派发走到的分支（超时分支的 r.code === null 就是其一）。
  const sourceText = readFileSync(join(pluginRoot, 'lib', 'index.js'), 'utf8');
  const lineOf = (index) => sourceText.slice(0, index).split('\n').length;
  // 两个模式缺一不可：第一个抓条件表达式里裸露的 undefined（`x: a ? b : undefined`），
  // 第二个抓「裸标识符 + 行尾 }/)」，也就是本次事故那行 `screenshotReview });` ——
  // 旧正则要求 undefined 后必须是逗号或行尾，恰好把它整条漏掉。
  const undefinedFields = [
    ...sourceText.matchAll(/^\s*([A-Za-z_$][\w$]*):[^\n]*?(?<![=!?.\w])\bundefined\b\s*(?:,|$|[})])/gm),
    ...sourceText.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$|[})])/gm).filter(
      (m) => m[1] === 'undefined',
    ),
  ].map((m) => `${m[1]}（第 ${lineOf(m.index)} 行）`);
  check(
    undefinedFields.length === 0,
    'lib/index.js 没有「显式赋 undefined」的返回字段',
    undefinedFields.length ? `${undefinedFields.join('; ')} ← 可选键要用条件展开省略` : '可选键一律条件展开省略，或用 ?? null（仅限 schema 允许 null 的键）',
  );
} catch (error) {
  bad('6.5 节自身抛异常', error?.stack?.split('\n').slice(0, 6).join('\n'));
} finally {
  config.workspaceRoot = savedWorkspaceRoot;
  rmSync(tempRoot, { recursive: true, force: true });
}

// ── 6.6 端到端真构建（可选） ─────────────────────────────────────────────────
// 6.5 用临时 root + 假 gradlew 覆盖了「无产物」这条路；这里用**真实项目根**跑一次
// api 增量构建，让「宿主接受返回值」在真实日志、真实错误提取下也成立。
// 默认不跑（增量构建也要数秒）：
//   node scripts/contract-test.mjs --live-build
if (args.includes('--live-build')) {
  console.log('\n=== 6.6 端到端真构建 kirara_build api（--live-build） ===');
  const started = Date.now();
  const outcome = await dispatchTool('kirara_build', { project: 'api' });
  const problem = inspectOutcome('kirara_build', outcome);
  const statusLine = (outcome.finished?.content?.[0]?.text ?? '').split('\n')[0];
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  if (problem !== undefined) {
    bad('真实 api 构建经宿主返回', `${problem}（${elapsed}）`);
  } else if (/undefined/.test(statusLine)) {
    bad('真实 api 构建状态行不得出现 undefined 字样', `${statusLine}（${elapsed}）`);
  } else {
    ok('真实 api 构建经宿主返回', `${statusLine.slice(0, 96)}（${elapsed}）`);
  }
}

// ── 7. 模块身份唯一性（事故根因守卫） ────────────────────────────────────────
console.log('\n=== 7. 模块身份唯一性 ===');
console.log(`  宿主加载的 dsh-tools = ${toolsUrl}`);
const others = [];
for (const [label, root] of [['profile', join(profileDir, 'node_modules')], ['plugin', join(pluginDir, 'node_modules')]]) {
  const dir = join(root, '@deepseek-ai', 'dsh-tools');
  if (!existsSync(dir)) continue;
  const manifest = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {};
  others.push(`${label}: ${dir}${manifest.version ? ` (v${manifest.version})` : ''}`);
}
if (others.length === 0) {
  ok('测试路径下没有其它 dsh-tools 物理副本', 'profile 与插件目录都干净 ⇒ 宿主与插件必然共用同一模块实例');
} else {
  // profile 副本 = 真事故（routeScoped 会优先采用本地物理候选）；插件目录副本只是本地开发残留
  const profileLeak = others.some((line) => line.startsWith('profile:'));
  const detail = others.join('；');
  if (profileLeak) {
    bad('profile 里出现了 dsh-tools 物理副本', `${detail} ← 这就是 undefined.prepare() 的成因，跑 node scripts/deploy.mjs 清理`);
  } else {
    ok('profile 里没有 dsh-tools 副本', `${detail}（插件目录的开发副本不参与部署，无影响）`);
  }
}
const hostScopeCopies = [];
try {
  for (const entry of readdirSync(join(profileDir, 'node_modules', '@deepseek-ai'))) hostScopeCopies.push(entry);
} catch {
  /* 目录不存在 = 干净 */
}
check(hostScopeCopies.length === 0, 'profile 的 @deepseek-ai/ 为空', hostScopeCopies.length === 0 ? 'ok' : `发现：${hostScopeCopies.join(', ')}`);

console.log(`\n${failures === 0 ? '✅ 契约成立' : `✗ ${failures} 项断言失败`}`);
process.exit(failures === 0 ? 0 : 1);
