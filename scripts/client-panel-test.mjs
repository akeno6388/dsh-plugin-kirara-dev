#!/usr/bin/env node
/**
 * 浏览器半边（lib/client.js）的**无浏览器**回归测试。
 * ---------------------------------------------------------------------------
 * 为什么要有它：「插件管理页里能不能真的出现更新控件」是这套自更新最容易出错的一环，
 * 但它跑在浏览器里，Node 侧的自检夹具覆盖不到。这里把宿主外壳的两件事伪造出来：
 *   1. window.__ModuleLoader__.load({ id, factory })  —— 客户端模块系统唯一的入口；
 *   2. ctx.slots.inject / slots.register              —— 详情页三个插槽的注册 API。
 * 然后用 react-dom/server 真渲染每个注册项，断言：认领自己的 subject、对外来 subject 渲染 null。
 *
 * 跑法：node scripts/client-panel-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(REPO_DIR, 'package.json'));
const React = require('react');
const ReactDOMServer = require('react-dom/server');

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
const PKG = manifest.name;
const source = fs.readFileSync(path.join(REPO_DIR, 'lib', 'client.js'), 'utf8');

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(label);
};

// ── 宿主外壳的三件事：index 注入（window[GLOBAL_KEY]）、模块加载器、最小 DOM ──────────
const globalKeyMatch = /__KIRARA_[A-Z]+_UPDATE__/.exec(source);
const GLOBAL_KEY = globalKeyMatch ? globalKeyMatch[0] : null;
check('识别出引导层注入用的全局键', !!GLOBAL_KEY, GLOBAL_KEY || '源码里没找到');

function makeNode() {
  const node = {
    style: { setProperty() {}, removeProperty() {}, cssText: '' },
    dataset: {}, children: [], className: '', id: '', textContent: '', innerHTML: '',
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    removeChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return node;
}
const doc = {
  head: makeNode(), body: makeNode(), documentElement: makeNode(),
  createElement: () => makeNode(), createTextNode: () => makeNode(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, readyState: 'complete',
};

let loaded = null;
const win = {
  location: { href: 'http://127.0.0.1:3964/', origin: 'http://127.0.0.1:3964' },
  navigator: { userAgent: 'node' },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  document: doc,
  __ModuleLoader__: { load(entry) { loaded = entry; } },
};
if (GLOBAL_KEY) {
  win[GLOBAL_KEY] = { pkg: PKG, routePath: '/kirara-update-test', channel: 'main', version: '1.2.3' };
}

const sandbox = {
  window: win, self: win, globalThis: win, console,
  document: doc,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  require: (name) => (name === 'react' ? React : require(name)),
};
vm.createContext(sandbox);
new vm.Script(source, { filename: 'lib/client.js' }).runInContext(sandbox);

check('客户端包用 __ModuleLoader__.load 注册了自己', !!loaded);
check('注册 id 等于包名（外壳按包名解析）', !!loaded && loaded.id === PKG, loaded && loaded.id);

// ── 用假 ctx 跑一次 apply，把三个插槽的注册项收集起来 ────────────────────────────────
const registered = [];
/**
 * slots 服务的要点（照 cordis 的真实语义）：`inject(name, callback)` **会调用**callback，
 * 回调返回的才是 dispose；`register(entry, renderer)` 返回 dispose。夹具这里必须照做，
 * 否则「注册了没有」根本测不出来。
 */
function makeSlots(bucket) {
  return {
    inject(name, callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    register(entry, renderer) { bucket.push({ entry, renderer }); return () => {}; },
  };
}
function makeCtx(bucket = registered) {
  const ctx = {
    slots: makeSlots(bucket),
    inject(names, callback) {
      if (Array.isArray(names) && names.includes('slots')) callback(makeCtx(bucket));
      else callback(ctx);
      return () => {};
    },
    effect() { return () => {}; }, on() { return () => {}; }, get() { return undefined; },
    plugin() {}, emit() {},
  };
  return ctx;
}

let applyError = null;
try {
  const plugin = loaded.factory(sandbox.require);
  check('factory 返回插件对象', !!plugin && typeof plugin.apply === 'function');
  plugin.apply(makeCtx());
} catch (error) {
  applyError = error;
}
check('apply 不抛异常', applyError === null, applyError ? String(applyError.message) : '');

const NAMES = ['plugins.detail.badge', 'plugins.detail.actions', 'plugins.detail.section'];
for (const name of NAMES) {
  const hit = registered.find((item) => item.entry && item.entry.name === name);
  check('注册了 ' + name, !!hit, hit ? 'id=' + hit.entry.id + ' order=' + hit.entry.order : '未注册');
}

// ── 真渲染：自己的 subject 要有内容，外来 subject 必须是 null ─────────────────────────
const mine = { kind: 'bundle', pkg: { name: PKG, version: '1.2.3', installed: true, enabled: true } };
const others = [
  { kind: 'bundle', pkg: { name: '@someone/other-plugin', version: '1.0.0', installed: true, enabled: true } },
  { kind: 'item', id: '@deepseek-ai/dsh-base' },
];
const renderEntry = (item, subject) => {
  try {
    return ReactDOMServer.renderToStaticMarkup(React.createElement(
      () => item.renderer({ t: (key) => key, subject }),
      null,
    ));
  } catch (error) {
    return 'RENDER_ERROR: ' + String(error.message);
  }
};

let painted = 0;
for (const item of registered) {
  const own = renderEntry(item, mine);
  check(item.entry.name + ' 在自己的详情页渲染出内容', own.length > 0 && !own.startsWith('RENDER_ERROR'), own.slice(0, 70));
  if (own.length > 0 && !own.startsWith('RENDER_ERROR')) painted += 1;
  for (const foreign of others) {
    const html = renderEntry(item, foreign);
    check(item.entry.name + ' 对 ' + (foreign.pkg ? foreign.pkg.name : foreign.id) + ' 渲染 null', html === '', JSON.stringify(html.slice(0, 40)));
  }
}
check('三个插槽都能画出东西', painted === 3, painted + '/3');

// 自己的页面上应当出现「更新」语义的文案（按钮或标签）
const actions = registered.find((item) => item.entry.name === 'plugins.detail.actions');
if (actions) {
  const html = renderEntry(actions, mine);
  check('页头控件里有更新/同步字样', /更新|同步|检查/.test(html), html.slice(0, 90));
}

// ── 客户端写死的默认路由必须等于引导层注册的路由前缀（否则点按钮就是 404） ──────────
const bootstrap = fs.readFileSync(path.join(REPO_DIR, 'lib', 'index.js'), 'utf8');
const clientDefault = /var DEFAULT_ROUTE = "([^"]+)"/.exec(source);
const bootDefault = /DEFAULT_ROUTE_PATH = '([^']+)'/.exec(bootstrap);
check(
  '客户端默认路由 == 引导层路由前缀',
  !!clientDefault && !!bootDefault && clientDefault[1] === bootDefault[1],
  (clientDefault ? clientDefault[1] : '(客户端里没找到)') + ' vs ' + (bootDefault ? bootDefault[1] : '(引导层里没找到)'),
);
check('引导层用 prefix 注册路由', /kind: 'prefix'/.test(bootstrap));
check('引导层认识 check / sync / rollback 三个动作', ['check', 'sync', 'rollback'].every((a) => new RegExp("'" + a + "'").test(bootstrap)));
check('客户端一律用 POST 调这些动作', /method: "POST"/.test(source));

if (process.argv.includes('--dump')) {
  console.log('\n=== 详情页上会渲染出的 HTML（自己的 subject） ===');
  for (const item of registered) {
    console.log('\n--- ' + item.entry.name + ' ---');
    console.log(renderEntry(item, mine));
  }
}

if (failures.length === 0) {
  console.log('\n✅ 浏览器半边回归通过（' + registered.length + ' 个插槽注册项）');
  process.exit(0);
}
console.error('\n❌ 失败 ' + failures.length + ' 项：' + failures.join('；'));
process.exit(1);
