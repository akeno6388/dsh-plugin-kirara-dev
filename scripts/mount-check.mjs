/**
 * 挂载路径检查 —— 复现 DSH app-boot 的**两锚点解析判定**，验证插件在真实加载
 * 路径上拿到的是宿主那一份依赖（而不是 profile 里的第二份副本），随后串行跑
 * `contract-test.mjs`，用真实 `ToolRuntime` 走完整调度链路。
 *
 * ⚠️ 第 1 步的断言方向在 2026-10 被**反转**了：旧版本这里断言
 *   `createRequire(profileDir).resolve('@deepseek-ai/dsh-tools')` 成功 ——
 * 那正是事故的成因。宿主包一旦在 profile 里有物理副本，`routeScoped()` 就返回
 * `kind: 'native'`（本地物理副本优先），宿主于是加载第二份 `dsh-tools`，
 * `TOOL_RUNTIME_SCHEDULER` Symbol 分裂，**所有**工具派发（含内置 read/pwsh）
 * 崩在 `Cannot read properties of undefined (reading 'prepare')`。
 * 正确形态：profile 里没有副本 ⇒ 判定 `interception` ⇒ 由宿主安装
 * （`scope: 'installation'`）提供同一模块实例。
 *
 * 判定逻辑抄自 `@deepseek-ai/dsh-app-boot` 的 `routeScoped`：走
 * `createRequire(parent).resolve.paths(name)`，被 `layer.localPrefix` 截断；
 * 任一物理候选存在 → native（本地赢）；否则 → interception。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = dirname(here);
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', process.env.DSH_PROFILE || 'desktop');
const profileNodeModules = join(profileDir, 'node_modules');
const deployedDir = join(profileNodeModules, '@kirara', 'dsh-plugin-kirara-dev');

const HOST_PACKAGES = ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'];
let failures = 0;
const check = (cond, label, detail) => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `\n      ${detail}` : ''}`);
};

console.log('=== 1) profile 归层判定（模拟 routeScoped） ===');
console.log(`  profile 层 localPrefix = ${profileNodeModules}`);
if (!existsSync(join(deployedDir, 'lib', 'index.js'))) {
  check(false, 'profile 里存在已部署的插件副本', `${deployedDir} 不存在 —— 先跑 node scripts/deploy.mjs`);
} else {
  const req = createRequire(join(deployedDir, 'lib', 'index.js'));
  for (const dep of HOST_PACKAGES) {
    const paths = req.resolve.paths(dep) ?? [];
    const inProfile = paths.filter((p) => p === profileNodeModules || p.startsWith(profileNodeModules + '\\'));
    const hits = inProfile.filter((p) => existsSync(join(p, ...dep.split('/'))));
    if (hits.length === 0) {
      console.log(`  ✓ ${dep}: 无本地物理候选 → 判定 interception（由宿主安装提供）`);
      console.log(`      搜索路径共 ${paths.length} 条，profile 内命中 0 条 ⇒ 与 dsh-agent-loop 共用同一模块实例`);
    } else {
      check(false, `${dep}: profile 内存在物理副本 → 判定 kind:'native'`, `命中：${hits.join('; ')}`);
    }
  }
  // 一致性：`file:` 安装是**拷贝**，不重新部署就会一直跑旧代码
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  for (const rel of ['package.json', 'lib/index.js', 'cordis.patch.yml']) {
    const a = join(deployedDir, rel);
    const b = join(pluginDir, rel);
    check(
      existsSync(a) && existsSync(b) && hash(a) === hash(b),
      `部署副本 == 源码: ${rel}`,
      existsSync(a) ? undefined : '部署副本缺该文件 —— 跑 node scripts/deploy.mjs',
    );
  }
}

console.log('\n=== 2) 插件清单形态（根因守卫） ===');
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const asDeps = HOST_PACKAGES.filter((name) => manifest.dependencies?.[name] !== undefined);
check(asDeps.length === 0, '宿主包不是 dependencies', asDeps.length ? `仍在 dependencies: ${asDeps.join(', ')}` : 'ok');
check(
  HOST_PACKAGES.every((name) => manifest.peerDependencies?.[name] !== undefined),
  '宿主包声明为 peerDependencies',
  HOST_PACKAGES.map((n) => `${n}@${manifest.peerDependencies?.[n] ?? '(缺失)'}`).join(', '),
);

console.log('\n=== 3) 真实 ToolRuntime 契约（委托 contract-test.mjs） ===');
const run = spawnSync(process.execPath, [join(here, 'contract-test.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
if (run.status !== 0) failures += 1;

console.log(`\n${failures === 0 ? '✅ 挂载路径与运行契约全部成立' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
