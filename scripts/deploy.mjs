#!/usr/bin/env node
/**
 * 部署 / 校验：把本插件同步进 desktop profile，并断言
 * 「不污染宿主模块身份」的不变量（DRSH 工具调度崩溃的根因守卫）。
 *
 * 背景（2026-10 事故，详见 README §4）：插件曾把 @deepseek-ai/dsh-tools /
 * @deepseek-ai/schemastery 声明为 **dependencies**，pnpm 于是把它们（及其依赖）
 * 铺到 `profiles/desktop/node_modules/@deepseek-ai/*`。app-boot 的解析器
 * `routeScoped` 对 profile 层优先采用「本地物理候选」（kind: 'native'），
 * 于是宿主 `tools` 服务来自 profile 副本、而 `dsh-agent-loop` 用的是安装副本，
 * 两个 `TOOL_RUNTIME_SCHEDULER` Symbol 不是同一个 → `ctx.tools[SYMBOL]` 为
 * undefined → 每次工具派发（含内置 read/pwsh）都崩在 `undefined.prepare(...)`。
 *
 * 因此有两条硬性不变量：
 *   1. 宿主的 @deepseek-ai/dsh-* 包 **不得** 出现在 profile 的 node_modules 里
 *      （它们只能由宿主的 runtime resolution 提供）；
 *   2. profile 里的插件副本必须与源码逐字节一致（`file:` 安装是**拷贝**，
 *      不重新部署的话 DSH 跑的是旧代码）。
 *
 * 用法：
 *   node scripts/deploy.mjs           # 重新链接 profile 依赖 → 部署最新源码
 *   node scripts/deploy.mjs --check   # 只校验不写入；有任何漂移则退出码 1
 *   node scripts/deploy.mjs --enable   # 幂等地把插件挂进 profile 的 dsh.profile.bundles
 *   node scripts/deploy.mjs --disable  # 反挂（排查用：隔离插件时不必手改 JSON）
 *
 * 可用环境变量覆盖：
 *   DSH_HOME               默认 %USERPROFILE%\.dsh
 *   DSH_PROFILE            默认 desktop
 *   DSH_PNPM               pnpm.cjs 绝对路径（默认自动在 DeepSeek Harness 里找）
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = '@kirara/dsh-plugin-kirara-dev';
/** 必须由宿主 runtime resolution 提供、绝不能落进 profile 的包。 */
export const HOST_PACKAGES = ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'];

export const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));

export function resolvePaths() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profileName = process.env.DSH_PROFILE || 'desktop';
  const profileDir = join(dshHome, 'profiles', profileName);
  const profileNodeModules = join(profileDir, 'node_modules');
  const installedDir = join(profileNodeModules, ...PLUGIN_NAME.split('/'));
  return { dshHome, profileName, profileDir, profileNodeModules, installedDir };
}

/** 找到 DSH 自带的 pnpm（`resources/runtime/pnpm/bin/pnpm.cjs`）。 */
export function findPnpm() {
  if (process.env.DSH_PNPM) return existsSync(process.env.DSH_PNPM) ? process.env.DSH_PNPM : undefined;
  const roots = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs'),
    join(process.env.LOCALAPPDATA ?? '', ''),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let names = [];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /deepseek|dsh/i.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const candidate = join(root, name, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.cjs');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 采集不变量报告（只读）。 */
export function inspect() {
  const paths = resolvePaths();
  const { profileDir, profileNodeModules, installedDir } = paths;
  const result = { paths, checks: [] };
  const check = (ok, label, detail) => result.checks.push({ ok, label, detail });

  // 0) profile 是否登记了本插件、是否在 bundles 里
  const profileManifestPath = join(profileDir, 'package.json');
  const manifest = existsSync(profileManifestPath) ? JSON.parse(readFileSync(profileManifestPath, 'utf8')) : undefined;
  const specifier = manifest?.dependencies?.[PLUGIN_NAME];
  check(specifier !== undefined, `profile 已登记 ${PLUGIN_NAME}`, specifier ?? '未登记（profile/package.json 的 dependencies 里没有）');
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  const bundled = bundles.includes(PLUGIN_NAME);
  // bundles 里没有 ⇒ 插件不会被挂载（工具不会出现），但不算「坏了」
  result.bundles = bundles;
  result.bundled = bundled;

  // 1) 插件自身的清单：宿主包必须是 peerDependencies（根因守卫）
  const pluginManifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
  const badDeps = HOST_PACKAGES.filter((name) => pluginManifest.dependencies?.[name] !== undefined);
  check(
    badDeps.length === 0,
    '插件清单：宿主包不是 dependencies',
    badDeps.length ? `仍在 dependencies：${badDeps.join(', ')} ← 会让 pnpm 把宿主包铺进 profile` : 'ok',
  );
  const missingPeers = HOST_PACKAGES.filter((name) => pluginManifest.peerDependencies?.[name] === undefined);
  check(
    missingPeers.length === 0,
    '插件清单：宿主包声明为 peerDependencies',
    missingPeers.length
      ? `缺 peer：${missingPeers.join(', ')} ← 宿主 runtime resolution 不会为它们做拦截`
      : HOST_PACKAGES.map((n) => `${n}@${pluginManifest.peerDependencies[n]}`).join(', '),
  );

  // 1b) lockfile 不得把宿主包记成运行期依赖（残留旧锁会诱导后来者把 dependencies 加回去）
  const lockPath = join(pluginDir, 'package-lock.json');
  const lockRoot = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8'))?.packages?.[''] : undefined;
  const lockBad = lockRoot === undefined ? [] : HOST_PACKAGES.filter((name) => lockRoot.dependencies?.[name] !== undefined);
  check(
    lockBad.length === 0,
    'lockfile 不把宿主包当运行期依赖',
    !existsSync(lockPath)
      ? '无 lockfile（可接受）'
      : lockBad.length
        ? `${lockBad.join(', ')} 在 lockfile 的 dependencies 段 ← 跑 npm install --package-lock-only 重生成`
        : '宿主包只出现在 devDependencies / peerDependencies',
  );

  // 1c) 展示元信息（插件列表里的标题/描述）必须能被 Node 解析到。
  //     这条最容易静默失效：exports 少了 "./locale/*.json"，或 en.json 缺了，
  //     DSH 只会「当作没有元信息」，列表回退显示原始包名，不报任何错。
  const localeExport = pluginManifest.exports?.['./locale/*.json'];
  const englishLocale = join(pluginDir, 'locale', 'en.json');
  const localesPresent = existsSync(englishLocale);
  check(
    typeof localeExport === 'string' && localesPresent,
    '插件清单：展示元信息可解析',
    !localesPresent
      ? '缺 locale/en.json ← 插件列表只能显示原始包名'
      : typeof localeExport !== 'string'
        ? 'exports 缺 "./locale/*.json" ← 元信息会被静默忽略，列表回退成包名'
        : `${localeExport} + locale/en.json`,
  );

  // 2) profile 的 node_modules 里不得有宿主包的第二副本
  const leaked = [];
  for (const pkg of HOST_PACKAGES) {
    const dir = join(profileNodeModules, ...pkg.split('/'));
    if (existsSync(dir)) leaked.push(dir);
  }
  for (const scope of ['@deepseek-ai', '@standard-schema']) {
    const dir = join(profileNodeModules, scope);
    if (!existsSync(dir)) continue;
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      entries = [];
    }
    for (const entry of entries) leaked.push(join(dir, entry));
  }
  check(
    leaked.length === 0,
    'profile 无宿主包物理副本（模块身份唯一）',
    leaked.length ? `发现：${leaked.join(', ')}` : `${profileNodeModules} 只有 @kirara`,
  );

  // 3) 部署副本与源码一致（含随包文档与展示元信息）
  //    locale/*.json 提供插件列表里的标题与描述，漂移了不会报错、只会静默显示旧文案，
  //    所以必须逐字节比。
  const mismatches = [];
  for (const rel of ['package.json', 'lib/index.js', 'cordis.patch.yml', 'README.md', 'locale/en.json', 'locale/zh.json']) {
    const deployed = join(installedDir, rel);
    if (!existsSync(deployed)) {
      mismatches.push(`${rel} 缺失`);
      continue;
    }
    const source = join(pluginDir, rel);
    if (sha256(deployed) !== sha256(source)) mismatches.push(`${rel} 不一致`);
  }
  check(
    mismatches.length === 0,
    'profile 副本与源码逐字节一致',
    mismatches.length ? `${mismatches.join('；')} ← 跑一次 node scripts/deploy.mjs` : installedDir,
  );

  // 4) 副本的 Node 搜索路径里不得存在宿主包候选（否则 kind:'native' 会赢过拦截）
  const candidates = [];
  if (existsSync(join(installedDir, 'lib'))) {
    const req = createRequire(join(installedDir, 'lib', 'index.js'));
    for (const pkg of HOST_PACKAGES) {
      for (const searchPath of req.resolve.paths(pkg) ?? []) {
        const candidate = join(searchPath, ...pkg.split('/'));
        if (existsSync(candidate)) candidates.push(candidate);
      }
    }
  }
  check(
    candidates.length === 0,
    '副本侧无本地解析候选（只能由宿主拦截提供）',
    candidates.length ? `发现：${candidates.join(', ')}` : '全部候选都不存在 ⇒ 必然走宿主 runtime resolution',
  );

  // 5) 副本是否已构建态可用（lib/index.js 存在且非空）
  const entry = join(installedDir, 'lib', 'index.js');
  check(
    existsSync(entry) && statSync(entry).size > 1024,
    '副本入口 lib/index.js 可用',
    existsSync(entry) ? `${statSync(entry).size} B` : '缺失',
  );

  return result;
}

function printReport(result) {
  let failed = 0;
  for (const { ok, label, detail } of result.checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (detail) console.log(`      ${detail}`);
  }
  if (!result.bundled) {
    console.log(`  ! profile 的 dsh.profile.bundles 尚未包含 ${PLUGIN_NAME}`);
    console.log(`      当前：${JSON.stringify(result.bundles)}`);
    console.log('      插件不会被挂载 ⇒ 重启 DSH 后模型看不到 kirara_* 工具。');
    console.log('      要启用：在 profile/package.json 的 bundles 数组里加上它（或用 DSH 的插件管理界面）。');
  }
  return failed;
}

function deploy() {
  const { profileDir, profileNodeModules } = resolvePaths();
  const pnpm = findPnpm();
  if (!pnpm) {
    console.error('找不到 pnpm：请设置 DSH_PNPM 指向 <DSH>/resources/runtime/pnpm/bin/pnpm.cjs');
    process.exit(2);
  }
  console.log(`【部署】pnpm = ${pnpm}`);
  console.log(`        profile = ${profileDir}`);
  if (existsSync(profileNodeModules)) {
    console.log('        清空 node_modules（`file:` 安装是拷贝，pnpm 不会主动重建被改动的副本）');
    rmSync(profileNodeModules, { recursive: true, force: true });
  }
  const run = spawnSync(process.execPath, [pnpm, 'install', '--dir', profileDir, '--no-frozen-lockfile', '--reporter=append-only'], {
    stdio: 'inherit',
  });
  if (run.status !== 0) {
    console.error(`pnpm install 失败，退出码 ${run.status}`);
    process.exit(run.status ?? 1);
  }
  console.log('        提示：pnpm 会报 "Issues with peer dependencies found"，这是**预期**的 ——');
  console.log('              宿主包由 DSH 的 runtime resolution 提供，不该装进 profile。');
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

/**
 * 幂等地增删 profile 的 `dsh.profile.bundles` 条目。
 * bundles 顺序就是 patch 叠加顺序，插件必须排在 `dsh-base` / `dsh-web-app` **之后**。
 * @param {'enable' | 'disable'} mode - 目标状态。
 */
function setBundle(mode) {
  const { profileDir } = resolvePaths();
  const file = join(profileDir, 'package.json');
  if (!existsSync(file)) {
    console.error(`找不到 profile 清单：${file}`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const specifier = manifest.dependencies?.[PLUGIN_NAME];
  if (mode === 'enable' && specifier === undefined) {
    console.error(`profile 未声明依赖 ${PLUGIN_NAME}`);
    console.error(`  请先在 ${file} 的 dependencies 里加上：`);
    console.error(`  "${PLUGIN_NAME}": "file:${pluginDir.replace(/\\/g, '/')}"`);
    process.exit(1);
  }
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  const bundles = (manifest.dsh.profile.bundles ??= []);
  const present = bundles.includes(PLUGIN_NAME);
  const want = mode === 'enable';
  console.log(`【bundles ${mode}】${file}`);
  console.log(`  当前：${JSON.stringify(bundles)}`);
  if (present === want) {
    console.log(`  已是目标状态，无需改动`);
    return;
  }
  if (want) bundles.push(PLUGIN_NAME);
  else bundles.splice(bundles.indexOf(PLUGIN_NAME), 1);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`  写入：${JSON.stringify(bundles)}`);
  console.log(`  ⚠️ 需要完全重启 DSH 才生效（bundles 只在启动时读一次）`);
}

if (invokedDirectly) {
  const checkOnly = process.argv.includes('--check');
  const enable = process.argv.includes('--enable');
  const disable = process.argv.includes('--disable');
  if (enable || disable) setBundle(enable ? 'enable' : 'disable');
  if (!checkOnly && !enable && !disable) deploy();
  console.log(`\n【不变量校验】${checkOnly ? '(仅校验)' : '(部署后)'}`);
  const failed = printReport(inspect());
  if (failed > 0) {
    console.error(`\n✗ ${failed} 项不变量未满足`);
    process.exit(1);
  }
  console.log('\n✅ 不变量全部满足');
}
