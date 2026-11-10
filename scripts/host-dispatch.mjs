/**
 * 真宿主派发回归 —— 走**现行**的 `ctx.tools.setExecutor()` + native 执行器，
 * 把 10 个 kirara_* 逐个真派发一遍，证明「宿主接受返回值」。
 *
 * 为什么不是 contract-test.mjs：那一份依赖 `TOOL_RUNTIME_SCHEDULER` 这个导出符号，
 * 而 0.2.2-rc.1 起宿主改成了「ToolsService.setExecutor + @deepseek-ai/dsh-tool-executor-native」，
 * 符号不再导出 ⇒ contract-test 在本机宿主上从第 2 节就整段红（与插件改动无关，
 * 见 docs/troubleshooting.md 事故六）。这一份用**现行** API，因此能真跑。
 *
 * 它守的是那个踩过两次的坑：返回值的可选键不能是**显式 undefined**
 * （宿主对返回值做 lossless JSON 快照 + output.schema 校验，一次拒收就是
 * `tool "…" returned invalid output`）。新增可选键（screenshots / verdicts / macCommands…）
 * 的那一轮必须跑它。
 *
 * 用法：
 *   node scripts/host-dispatch.mjs                  # 测 profile 里已部署的副本
 *   node scripts/host-dispatch.mjs --from source    # 测源码树
 *   node scripts/host-dispatch.mjs --host <node_modules 绝对路径>   # 显式指定宿主包目录
 *
 * 退出码 0 = 全部被接受；1 = 有工具被拒。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
};

const wantSource = args.includes('--from') && flagValue('--from') === 'source';
// ⚠️ profile 目录名不一定等于 `desktop`（本机是 desktop-017），优先用宿主导出的 DSH_PROFILE_DIR。
const profileDir =
  process.env.DSH_PROFILE_DIR ||
  join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE || 'desktop');
const deployedDir = join(profileDir, 'node_modules', '@kirara', 'dsh-plugin-kirara-dev');
const useDeployed = !wantSource && existsSync(join(deployedDir, 'lib', 'impl.js'));
const pluginRoot = useDeployed ? deployedDir : pluginDir;
const hostRoot = flagValue('--host') ?? process.env.DSH_HOST_NODE_MODULES ?? join(pluginDir, 'node_modules');

const load = (spec) => import(pathToFileURL(join(hostRoot, ...spec.split('/'))).href);

console.log('=== 被测对象 ===');
console.log(`  插件入口  : ${join(pluginRoot, 'lib', 'impl.js')}（${useDeployed ? 'profile 已部署副本' : '源码树'}）`);
console.log(`  宿主包目录: ${hostRoot}`);

if (!existsSync(join(hostRoot, '@deepseek-ai', 'dsh-tool-executor-native', 'lib', 'index.js'))) {
  console.error(`  ✗ 宿主包目录里没有 @deepseek-ai/dsh-tool-executor-native：${hostRoot}`);
  console.error('    用 --host 指向一个含宿主包安装的 node_modules 目录。');
  process.exit(2);
}

const { Context } = await load('@deepseek-ai/cordis/lib/index.js');
const { ToolsService } = await load('@deepseek-ai/dsh-tools/lib/index.js');
const nativeExec = await load('@deepseek-ai/dsh-tool-executor-native/lib/index.js');

const ctx = new Context();
// ToolsService 的构造只用到 systemPrompt.tools(cb)（注册投影函数），给个最小 stub 即可。
ctx.provide('systemPrompt', { tools: () => () => {} });
ctx.plugin(ToolsService);
await new Promise((r) => setTimeout(r, 30));
ctx.plugin(nativeExec);
await new Promise((r) => setTimeout(r, 30));
if (ctx.tools === undefined) {
  console.error('  ✗ ToolsService 未挂载');
  process.exit(2);
}
console.log('  ✓ 真实 cordis Context + ToolsService + native 执行器已就位');

const mod = await import(`${pathToFileURL(join(pluginRoot, 'lib', 'impl.js')).href}?v=${Date.now()}`);
const workspaceRoot = process.env.DSH_WORKSPACE || dirname(pluginDir);
ctx.plugin(mod, { workspaceRoot, buildTimeoutMs: 1200000 });
await new Promise((r) => setTimeout(r, 60));

let failures = 0;
const ok = (m, d) => console.log(`  ✓ ${m}${d ? `\n      ${d}` : ''}`);
const bad = (m, d) => {
  failures += 1;
  console.log(`  ✗ ${m}${d ? `\n      ${d}` : ''}`);
};

let callId = 0;
async function dispatch(name, callArgs) {
  const res = await ctx.tools.execute({
    calls: [{ id: `c${(callId += 1)}`, name, arguments: JSON.stringify(callArgs) }],
    // pipeline 直接读 signal.aborted ⇒ 必须给真实 AbortSignal，缺了会崩在 runGroup 里。
    signal: new AbortController().signal,
  });
  const settled = res.results?.[0]?.result ?? res.results?.[0];
  return { res, settled };
}

// 每一条都对应一种**不同的返回分支**，不是随便挑的参数：
//   - build 的 android / ios-klib / ios（后者在非 macOS 上走 macCommands 分支）
//   - verify 的 media-iOS 清单（steps 最长）与 Android 清单、带截图与不带截图
//   - profile 的 media（带 ios 块）、docsync 的 iOS 规则
const cases = [
  ['kirara_profile', { project: 'media' }],
  ['kirara_build', { project: 'media', target: 'ios-klib' }],
  ['kirara_build', { project: 'media', target: 'ios' }],
  ['kirara_verify', { summary: 'iOS 登录页按钮间距', project: 'media', mode: 'full', purpose: 'ui-design' }],
  [
    'kirara_verify',
    {
      summary: '设置页配色',
      project: 'media',
      mode: 'full',
      purpose: 'ui-design',
      screenshots: [fileURLToPath(import.meta.url)],
    },
  ],
  ['kirara_start', { request: '在 Mac 上调整 iOS 登录页的按钮间距' }],
  ['kirara_route', { request: 'iOS 模拟器上验证 WKWebView 桥', mode: 'full' }],
  ['kirara_docs', { keywords: ['DeviceHub'], project: 'media', maxHits: 4 }],
  ['kirara_docsync', { feature: 'iOS 端 WKWebView 桥接修复', project: 'media' }],
  ['kirara_summary', { feature: '宿主派发回归', mode: 'full', changes: ['lib/impl.js'] }],
  ['kirara_release_notes', { project: 'media' }],
];

console.log(`\n=== 真宿主派发 ${cases.length} 次（含 iOS 分支）===`);
for (const [name, callArgs] of cases) {
  const label = `${name}(${JSON.stringify(callArgs).slice(0, 56)})`;
  try {
    const { settled } = await dispatch(name, callArgs);
    const text = (settled?.content ?? []).map((b) => b?.text ?? '').join('');
    if (/invalid output|not lossless|unsupported JSON schema/i.test(text)) {
      bad(`${label}: 返回值被宿主拒收`, text.slice(0, 240));
      continue;
    }
    if (!text) {
      bad(`${label}: 无正文返回`, JSON.stringify(settled).slice(0, 200));
      continue;
    }
    // isError=true 只说明工具**业务**失败（例如本机没有 JDK，gradle 退出 9009），
    // 与契约无关 —— 契约的判据是有正文、且不是"invalid output"。
    const business = settled?.isError ? '（业务失败，契约仍成立）' : '';
    ok(`${label}: 宿主接受返回值${business}`, text.split('\n')[0].slice(0, 100));
  } catch (error) {
    const cause = error?.cause ? ` | cause=${error.cause?.message ?? error.cause}` : '';
    bad(`${label}: 派发抛异常`, `${String(error?.message ?? error).slice(0, 200)}${cause}`);
  }
}

console.log(`\n${failures === 0 ? '✅ 真宿主全部接受（可选键均按条件展开，无显式 undefined）' : `✗ ${failures} 项被拒`}`);
process.exit(failures === 0 ? 0 : 1);
