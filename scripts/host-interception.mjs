/**
 * Node 模块解析钩子：**模拟 DSH 宿主的 module interception 层**。
 *
 * 为什么需要它：DSH 加载插件时并不使用 Node 的普通解析。app-boot 的
 * `routeScoped()` 会在「没有本地物理候选」时，把宿主包（`@deepseek-ai/dsh-tools`
 * 等）**拦截**到安装目录那一份去；只有当 profile 里存在物理副本时才会退回
 * `kind: 'native'`。两套副本 = 两个 `TOOL_RUNTIME_SCHEDULER` Symbol = 工具派发
 * 崩在 `undefined.prepare(...)`。
 *
 * 这个钩子把同样的语义搬到纯 Node 里：宿主作用域内的包名**一律**指向
 * `DSH_HOST_NODE_MODULES` 指定的宿主安装目录，本地候选不参与；其余裸说明符
 * 先走正常解析，失败再回落到宿主目录（等价于「安装锚点优先」）。
 *
 * 通过 `module.register()` 使用，宿主根由环境变量 `DSH_HOST_NODE_MODULES`
 * （即含 `@deepseek-ai/*` 的 node_modules 目录）给出。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 必须由宿主任一份提供的包（插件里出现的宿主兄弟包）。 */
const HOST_SCOPED = new Set([
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  'cosmokit',
]);

const hostRoot = process.env.DSH_HOST_NODE_MODULES;
if (!hostRoot) throw new Error('缺少 DSH_HOST_NODE_MODULES（应指向宿主安装的 node_modules 目录）');

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** 按 package.json 的 exports/main 求出子路径对应的文件。 */
function entryOf(dir, sub) {
  const manifest = readManifest(dir);
  if (!manifest) return undefined;
  const key = sub === '' ? '.' : `./${sub}`;
  const exp = manifest.exports;
  if (exp !== undefined) {
    if (typeof exp === 'string' && sub === '') return join(dir, exp);
    const mapped = exp[key];
    if (typeof mapped === 'string') return join(dir, mapped);
    if (mapped && typeof mapped === 'object') {
      const rel = mapped.default ?? mapped.import ?? mapped.require ?? mapped.node;
      if (typeof rel === 'string') return join(dir, rel);
    }
    if (sub !== '' && exp['./*'] !== undefined && !sub.includes('*')) {
      // 形如 "./src/*": "./src/*" 的透传
      const rel = sub;
      if (existsSync(join(dir, rel))) return join(dir, rel);
    }
  }
  if (sub === '') {
    const rel = manifest.module ?? manifest.main ?? 'lib/index.js';
    return join(dir, rel);
  }
  for (const candidate of [sub, `${sub}.js`, `${sub}.mjs`, join(sub, 'index.js')]) {
    const file = join(dir, candidate);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return undefined;
}

/** 把裸说明符解析到宿主安装目录里的具体文件。 */
function hostResolve(specifier) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const sub = specifier.slice(name.length).replace(/^\//, '');
  const dir = join(hostRoot, ...name.split('/'));
  if (!existsSync(dir)) return undefined;
  const file = entryOf(dir, sub);
  return file === undefined ? undefined : pathToFileURL(file).href;
}

export async function resolve(specifier, context, nextResolve) {
  const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:') && !/^[a-z][a-z0-9+.-]*:/i.test(specifier);
  if (!bare) return nextResolve(specifier, context);

  const direct = HOST_SCOPED.has(specifier) ? hostResolve(specifier) : undefined;
  if (direct !== undefined) {
    return { url: direct, shortCircuit: true, format: 'module' };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const fallback = hostResolve(specifier);
    if (fallback !== undefined) return { url: fallback, shortCircuit: true, format: 'module' };
    throw error;
  }
}
