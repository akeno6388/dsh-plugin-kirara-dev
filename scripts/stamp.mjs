#!/usr/bin/env node
/**
 * 写发版印章：把当前 git HEAD 的 sha 写进 lib/build-info.js。
 * ---------------------------------------------------------------------------
 * 为什么需要它：插件同步更新时要比「我这份实现对应哪个提交」。
 * 印章缺失（null）也能工作，只是界面会把随包安装的那份显示成「未知提交」。
 *
 * 用法：
 *   node scripts/stamp.mjs           # 写入当前 HEAD
 *   node scripts/stamp.mjs --check   # 只校验：印章是否等于当前 HEAD（CI/发版前用）
 *
 * 建议在发版/打包前跑一次（scripts/deploy.mjs 不自动改源码，避免部署动作产生脏工作区）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(HERE, '..');
const TARGET = path.join(REPO_DIR, 'lib', 'build-info.js');

const head = execFileSync('git', ['-C', REPO_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['-C', REPO_DIR, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
const current = readFileSync(TARGET, 'utf8');
const match = /BUNDLED_SHA\s*=\s*(null|'[^']*'|"[^"]*")/.exec(current);
const stamped = match && match[1] !== 'null' ? match[1].replace(/['"]/g, '') : null;

if (process.argv.includes('--check')) {
  if (stamped === head) {
    console.log('✅ 印章与 HEAD 一致：' + head.slice(0, 12));
    process.exit(0);
  }
  console.error('❌ 印章 ' + (stamped ? stamped.slice(0, 12) : '(null)') + ' ≠ HEAD ' + head.slice(0, 12) + '，先跑 node scripts/stamp.mjs');
  process.exit(1);
}

writeFileSync(
  TARGET,
  current.replace(/BUNDLED_SHA\s*=\s*(null|'[^']*'|"[^"]*")/, "BUNDLED_SHA = '" + head + "'"),
);
console.log('已写入印章：' + head.slice(0, 12) + (dirty ? '（⚠️ 工作区有未提交改动，发版前记得先提交）' : ''));
