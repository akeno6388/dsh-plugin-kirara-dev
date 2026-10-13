#!/usr/bin/env node
/**
 * 自更新内核一致性校验：两个插件仓库里的 lib/update.js 必须**逐字节相同**。
 * ---------------------------------------------------------------------------
 * 内核是复制的（两个仓库各自独立发布，没有共享包），复制就会漂移；
 * 一旦漂移，「一个仓库修好的 bug 另一个没修」会在用户的机器上表现为随机行为。
 * 所以每次改动内核后跑一次这个脚本。
 *
 * 跑法：node scripts/check-kernel-parity.mjs [--other <另一个仓库目录>]
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(HERE, '..');
const SIBLINGS = ['dsh-plugin-kirara-dev', 'dsh-plugin-kirara-theme'];

const flagIndex = process.argv.indexOf('--other');
let otherDir = flagIndex >= 0 ? path.resolve(process.argv[flagIndex + 1]) : null;
if (!otherDir) {
  for (const name of SIBLINGS) {
    const candidate = path.resolve(REPO_DIR, '..', name);
    if (candidate !== REPO_DIR && existsSync(path.join(candidate, 'lib', 'update.js'))) {
      otherDir = candidate;
      break;
    }
  }
}

const ownFile = path.join(REPO_DIR, 'lib', 'update.js');
if (!otherDir) {
  console.error('找不到另一个插件仓库；用 --other <目录> 指定。');
  process.exit(2);
}
const otherFile = path.join(otherDir, 'lib', 'update.js');
for (const file of [ownFile, otherFile]) {
  if (!existsSync(file)) {
    console.error('缺少文件：' + file);
    process.exit(2);
  }
}

const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const mine = digest(ownFile);
const theirs = digest(otherFile);

console.log('本仓库   : ' + path.basename(REPO_DIR) + '  ' + mine.slice(0, 16));
console.log('对照仓库 : ' + path.basename(otherDir) + '  ' + theirs.slice(0, 16));
if (mine === theirs) {
  console.log('\n✅ lib/update.js 两边逐字节一致');
  process.exit(0);
}
console.error('\n❌ lib/update.js 已漂移：把改好的那一份复制到另一个仓库再提交。');
process.exit(1);
