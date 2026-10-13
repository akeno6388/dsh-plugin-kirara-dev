#!/usr/bin/env node
/**
 * 写发版印章：把「最后一次改到 lib/impl.js 的提交」的 sha 写进 lib/build-info.js。
 * ---------------------------------------------------------------------------
 * 为什么需要它：插件自更新时要判断「我这份实现对应哪个提交」。印章缺失（null）也能跑，
 * 只是界面会把随包安装的那份显示成「未知提交」。
 *
 * ⚠️ 取的是**实现层最后一次变更**的提交，不是 HEAD —— 与内核里
 *    GET /repos/<repo>/commits?path=lib/impl.js 的判据完全一致。
 *    这样纯文档提交不会把「已是最新」变成「有新版本」，印章也不会因为随后的提交而失效。
 *
 * 用法：
 *   node scripts/stamp.mjs           # 写入
 *   node scripts/stamp.mjs --check   # 只校验（发版前用）
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(HERE, '..');
const TARGET = path.join(REPO_DIR, 'lib', 'build-info.js');
const IMPL_PATH = 'lib/impl.js';

function git(args) {
  return execFileSync('git', ['-C', REPO_DIR, ...args], { encoding: 'utf8' }).trim();
}

/** 实现层最后一次变更的提交；仓库刚建、文件未提交时退回 HEAD。 */
const head = git(['log', '-1', '--format=%H', '--', IMPL_PATH]) || git(['rev-parse', 'HEAD']);
// 印章文件自己预期会变，不算脏。
const dirty = git(['status', '--porcelain'])
  .split('\n')
  .filter((line) => line.trim() && !line.includes('lib/build-info.js'))
  .join('\n')
  .trim();

const current = readFileSync(TARGET, 'utf8');
const match = /BUNDLED_SHA\s*=\s*(null|'[^']*'|"[^"]*")/.exec(current);
const stamped = match && match[1] !== 'null' ? match[1].replace(/['"]/g, '') : null;

if (process.argv.includes('--check')) {
  if (stamped === head) {
    console.log('✅ 印章与实现层最近提交一致：' + head.slice(0, 12));
    process.exit(0);
  }
  console.error('❌ 印章 ' + (stamped ? stamped.slice(0, 12) : '(null)') + ' ≠ 实现层最近提交 ' + head.slice(0, 12) + '，先跑 node scripts/stamp.mjs');
  process.exit(1);
}

writeFileSync(TARGET, current.replace(/BUNDLED_SHA\s*=\s*(null|'[^']*'|"[^"]*")/, "BUNDLED_SHA = '" + head + "'"));
console.log('已写入印章：' + head.slice(0, 12) + (dirty ? '（⚠️ 工作区有未提交改动，发版前记得先提交）' : ''));
