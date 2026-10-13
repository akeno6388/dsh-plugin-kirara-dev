#!/usr/bin/env node
/**
 * 自更新**真实链路**检查（联网，打真的 GitHub）。
 * ---------------------------------------------------------------------------
 * 与 update-e2e.mjs 的分工：
 *   - update-e2e.mjs 离线跑，验证状态机与热重载（假 GitHub、假发布）；
 *   - 本脚本联网跑，验证「真 API + 真 codeload + 真 git archive 产物」这条链路，
 *     用的还是同一个 lib/update.js，所以它能发现「真实的 tar 包解不开」这类问题。
 *
 * 做法：把本仓库的 lib/ + locale/ 复制到临时目录冒充「已安装包」，故意把 impl.js 改脏，
 * 然后 check() + sync()，断言：远端 sha 拿得到、文件被覆盖、覆盖后与本仓库逐字节一致、
 * 备份与 release.json 都写对了。全程只动临时目录。
 *
 * 跑法：node scripts/update-live-check.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdater } from '../lib/update.js';

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));

const root = path.join(os.tmpdir(), 'kirara-live-check-' + Date.now());
const pkgDir = path.join(root, 'installed');
fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
for (const name of fs.readdirSync(path.join(REPO_DIR, 'lib'))) {
  fs.copyFileSync(path.join(REPO_DIR, 'lib', name), path.join(pkgDir, 'lib', name));
}
fs.cpSync(path.join(REPO_DIR, 'locale'), path.join(pkgDir, 'locale'), { recursive: true });
fs.copyFileSync(path.join(REPO_DIR, 'package.json'), path.join(pkgDir, 'package.json'));

// 冒充「随包实现」：故意改脏，同步后必须被远端版本覆盖回本仓库那一份。
fs.appendFileSync(path.join(pkgDir, 'lib', 'impl.js'), '\n// live-check: 这一行必须被同步覆盖掉\n');
const before = fs.readFileSync(path.join(pkgDir, 'lib', 'impl.js'));

const updater = createUpdater({
  pkgName: manifest.name,
  repo: 'akeno6388/' + manifest.name.split('/').pop(),
  packageDir: pkgDir,
  bundledSha: null,
  config: { updateStoreRoot: path.join(root, 'store') },
});

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(label);
};

try {
  const status1 = await updater.check();
  const remote = status1.remote || {};
  console.log('远端实现层提交: ' + remote.sha + (remote.message ? '  ' + remote.message : ''));
  check('拿到远端 sha', typeof remote.sha === 'string' && remote.sha.length === 40);
  check('标记为有新版本', status1.updateAvailable === true);

  const started = Date.now();
  const result = await updater.sync();
  console.log('同步耗时      : ' + (Date.now() - started) + ' ms');
  check('同步结果 changed = true', result.changed === true, JSON.stringify(result.sha));

  const after = fs.readFileSync(path.join(pkgDir, 'lib', 'impl.js'));
  const expected = fs.readFileSync(path.join(REPO_DIR, 'lib', 'impl.js'));
  check('实现被远端覆盖', !before.equals(after));
  check('覆盖后与本仓库逐字节一致', after.equals(expected));
  check('写入 release.json', fs.existsSync(path.join(pkgDir, 'release.json')));
  const state = updater.status();
  check('记录了回滚备份', !!(state.previous && fs.existsSync(state.previous.backupDir)));

  const after2 = await updater.check();
  check('再查一次已是「最新」', after2.updateAvailable === false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures.length === 0) {
  console.log('\n✅ 真实链路通过');
  process.exit(0);
}
console.error('\n❌ 失败 ' + failures.length + ' 项：' + failures.join('；'));
process.exit(1);
