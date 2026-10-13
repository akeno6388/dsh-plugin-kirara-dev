#!/usr/bin/env node
/**
 * 自更新热切换的端到端自测（离线，不碰 GitHub、不碰 DSH 安装目录）。
 * ---------------------------------------------------------------------------
 * 它把「已安装的插件包」复制到临时目录，把实现换成会写日志的假实现，然后：
 *   1. 起一个假的 GitHub（只提供 commits 与 codeload 两个端点）；
 *   2. 用真的 cordis 挂载真的引导层 lib/index.js；
 *   3. 走真的 HTTP 路由：GET /state → POST /sync → POST /rollback；
 *   4. 断言：新实现被挂载、旧实现被 dispose、包目录被覆盖、备份可回滚。
 *
 * 跑法：node scripts/update-e2e.mjs [--keep]
 *   --keep  失败时保留临时目录，便于现场取证（默认无论成败都清理）。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(HERE, '..');
const FAKE_SHA = 'b'.repeat(40);
const ROUTE_PATH = '/kirara-update-e2e';
const KEEP = process.argv.includes('--keep');

const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    console.log('  ok  ' + label);
  } else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
};

/** 手写一个最小 ustar 条目（只为造 fixture；真实产物由 git archive 生成）。 */
function tarEntry(name, content) {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 99), 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

const makeTarball = (prefix, files) =>
  gzipSync(Buffer.concat(Object.entries(files).map((entry) => tarEntry(prefix + '/' + entry[0], entry[1])).concat([Buffer.alloc(1024)])));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs === undefined ? 20000 : timeoutMs);
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
}

function readLog(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function main() {
  const root = path.join(os.tmpdir(), 'kirara-update-e2e-' + process.pid);
  fs.rmSync(root, { recursive: true, force: true });
  const pkgDir = path.join(root, 'installed');
  const storeRoot = path.join(root, 'store');
  const logFile = path.join(root, 'impl.log');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.mkdirSync(storeRoot, { recursive: true });
  // 真实安装里插件位于 profile 的 node_modules 下，所以 @deepseek-ai/* 能解析到；这里用 junction 复现同样的解析环境。
  const hostModules = process.env.DSH_HOST_NODE_MODULES || path.join(REPO_DIR, 'node_modules');
  if (!fs.existsSync(hostModules)) {
    console.error('缺少宿主依赖目录（' + hostModules + '），先建 junction 或设 DSH_HOST_NODE_MODULES');
    process.exit(2);
  }
  fs.symlinkSync(hostModules, path.join(pkgDir, 'node_modules'), 'junction');

  // 假的「已安装包」：真的引导层 + 真的内核 + 假的实现（v1）。
  for (const file of ['index.js', 'update.js', 'build-info.js']) {
    fs.copyFileSync(path.join(REPO_DIR, 'lib', file), path.join(pkgDir, 'lib', file));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module' }, null, 2));

  const implSource = (tag) =>
    [
      "import fs from 'node:fs';",
      'const LOG = ' + JSON.stringify(logFile) + ';',
      'export function apply(ctx, config) {',
      "  fs.appendFileSync(LOG, JSON.stringify({ event: 'applied', tag: '" + tag + "', workspaceRoot: config && config.workspaceRoot }) + '\\n');",
      '  ctx.effect(() => () => {',
      "    fs.appendFileSync(LOG, JSON.stringify({ event: 'disposed', tag: '" + tag + "' }) + '\\n');",
      '  });',
      '}',
      '',
    ].join('\n');
  fs.writeFileSync(path.join(pkgDir, 'lib', 'impl.js'), implSource('v1'));

  // 假的 GitHub：只服务 commits 与 codeload 两个端点。
  const tarball = makeTarball(manifest.name.split('/').pop() + '-' + FAKE_SHA, {
    'package.json': JSON.stringify({ name: manifest.name, version: '0.3.0', type: 'module' }, null, 2),
    'lib/impl.js': implSource('v2'),
    'lib/index.js': fs.readFileSync(path.join(pkgDir, 'lib', 'index.js'), 'utf8'),
    'lib/update.js': fs.readFileSync(path.join(pkgDir, 'lib', 'update.js'), 'utf8'),
    'lib/build-info.js': fs.readFileSync(path.join(pkgDir, 'lib', 'build-info.js'), 'utf8'),
  });

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/repos/') && url.includes('/commits')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha: FAKE_SHA, commit: { message: 'e2e: fake release v2', committer: { date: new Date().toISOString() } } }));
      return;
    }
    if (url.indexOf('/tar.gz/') >= 0) {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(tarball);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  // 真的 cordis + 真的引导层。
  const cordis = await import(pathToFileURL(path.join(hostModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href);
  const ctx = new cordis.Context();
  const routes = [];
  ctx.plugin(function fakeWebServer(inner) {
    inner.provide('webServer', {
      register(options) {
        routes.push(options);
        return () => {
          const index = routes.indexOf(options);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    });
  });
  await sleep(200);

  const bootstrap = await import(pathToFileURL(path.join(pkgDir, 'lib', 'index.js')).href);
  const config = {
    workspaceRoot: 'X:/kirara',
    updateStoreRoot: storeRoot,
    updateRoutePath: ROUTE_PATH,
    updateAutoCheck: false,
    updateEndpoints: { api: base, codeload: base, git: base },
  };
  const scope = ctx.plugin(bootstrap, config);
  await scope;
  await sleep(300);

  const route = () => routes.find((entry) => entry.path === ROUTE_PATH);
  const call = (method, suffix) =>
    new Promise((resolve, reject) => {
      const target = route();
      if (!target) {
        reject(new Error('route not registered'));
        return;
      }
      const req = { method, url: ROUTE_PATH + suffix, headers: { host: '127.0.0.1' } };
      const chunks = [];
      const res = {
        statusCode: 0,
        writeHead(status) {
          this.statusCode = status;
        },
        end(body) {
          chunks.push(body ? Buffer.from(body) : Buffer.alloc(0));
          resolve({ status: this.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
        },
      };
      target.handler(req, res);
    });

  console.log('测试 1：引导层挂载随包实现');
  const applied1 = readLog(logFile).filter((entry) => entry.event === 'applied');
  check('随包实现 v1 已挂载', applied1.some((entry) => entry.tag === 'v1'), JSON.stringify(applied1));
  check('实现层收到透传配置 workspaceRoot', applied1.some((entry) => entry.workspaceRoot === 'X:/kirara'), JSON.stringify(applied1));
  check('更新路由已注册', !!route(), routes.map((entry) => entry.path).join(','));

  console.log('测试 2：GET /state（未检查前）');
  const state0 = await call('GET', '/state');
  check('HTTP 200', state0.status === 200, String(state0.status));
  check('current.source = bundled', state0.body.current && state0.body.current.source === 'bundled', JSON.stringify(state0.body.current));
  check('busy = idle', state0.body.busy === 'idle', String(state0.body.busy));

  console.log('测试 3：POST /sync → 下载 → 覆盖 → 热重载');
  const sync = await call('POST', '/sync');
  check('HTTP 202（立刻返回，后台下载）', sync.status === 202, String(sync.status));
  const reloaded = await waitFor(() => readLog(logFile).some((entry) => entry.event === 'applied' && entry.tag === 'v2'));
  check('新实现 v2 已挂载', reloaded);
  if (!reloaded) {
    const diag = await call('GET', '/state');
    console.log('  [诊断] ' + JSON.stringify({ busy: diag.body.busy, lastError: diag.body.lastError, log: diag.body.log }));
    console.log('  [目录] ' + JSON.stringify(fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot) : null));
  }
  check('旧实现 v1 已 dispose', readLog(logFile).some((entry) => entry.event === 'disposed' && entry.tag === 'v1'));
  check('包目录里的 impl.js 被覆盖成 v2', fs.readFileSync(path.join(pkgDir, 'lib', 'impl.js'), 'utf8').indexOf("'v2'") >= 0);
  const releaseFile = path.join(pkgDir, 'release.json');
  check('写入 release.json', fs.existsSync(releaseFile) && JSON.parse(fs.readFileSync(releaseFile, 'utf8')).sha === FAKE_SHA);
  const state1 = await call('GET', '/state');
  check('current.sha 已更新', state1.body.current && state1.body.current.sha === FAKE_SHA, JSON.stringify(state1.body.current));
  check('updateAvailable = false（已同步到最新）', state1.body.updateAvailable === false, String(state1.body.updateAvailable));
  const backupDir = state1.body.previous && state1.body.previous.backupDir;
  check('记录了回滚备份目录', !!backupDir && fs.existsSync(path.join(backupDir, 'lib', 'impl.js')), String(backupDir));

  console.log('测试 4：POST /rollback → 还原备份 → 再热重载');
  const rollback = await call('POST', '/rollback');
  check('HTTP 202', rollback.status === 202, String(rollback.status));
  const rolledBack = await waitFor(() => readLog(logFile).filter((entry) => entry.event === 'applied' && entry.tag === 'v1').length >= 2);
  check('v1 被重新挂载', rolledBack);
  check('impl.js 还原成 v1', fs.readFileSync(path.join(pkgDir, 'lib', 'impl.js'), 'utf8').indexOf("'v1'") >= 0);
  const state2 = await call('GET', '/state');
  check('current.source 回到 bundled', state2.body.current && state2.body.current.source === 'bundled', JSON.stringify(state2.body.current));
  check('更新日志有记录', Array.isArray(state2.body.log) && state2.body.log.length > 0, JSON.stringify(state2.body.log));

  console.log('测试 5：卸载插件时实现被回收');
  scope.dispose();
  await sleep(300);
  check('引导层卸载后实现 v1 被 dispose', readLog(logFile).filter((entry) => entry.event === 'disposed' && entry.tag === 'v1').length >= 2);

  server.close();
  if (failures.length === 0) {
    console.log('\n全部通过 ✅');
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
  }
  console.log('\n失败 ' + failures.length + ' 项 ❌');
  for (const item of failures) console.log('  - ' + item);
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
  else console.log('保留现场：' + root);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
