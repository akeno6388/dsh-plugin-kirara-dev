/**
 * 清单 / 浏览器半边的变化检测
 * ============================================================================
 *
 * 自更新只覆盖 `lib/` 与 `locale/`（见 lib/update.js 的 SYNCED_DIRS），所以一次 apply
 * 之后还有两件事必须判断，否则「点了同步更新」看起来成功、实际仍差半步：
 *
 *   1. `lib/client.js` 被换掉 → 浏览器跑的还是旧模块，页面得刷新一次才生效；
 *   2. 远端 `package.json` 与本地不同 → 清单类改动（依赖、`dsh.client`、exports）
 *      自更新永远送不到，只能重装插件 + 重启 DSH。
 *
 * 这里只放纯函数（不做 IO 之外的事、不依赖 cordis），方便在 clone 里直接单测。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 文件内容摘要。
 * @param {string} file
 * @returns {string|null} 文件不存在或读不了时返回 null（老版本可能没有 client.js）
 */
export function digestFile(file) {
  if (typeof file !== 'string' || !existsSync(file)) return null;
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** 包目录里浏览器半边的摘要。 */
export function clientDigest(packageDir) {
  return digestFile(join(packageDir, 'lib', 'client.js'));
}

/** 包目录里清单（package.json）的摘要。 */
export function manifestDigest(packageDir) {
  return digestFile(join(packageDir, 'package.json'));
}

/**
 * 一次 apply 之后的补充判定。
 *
 * @param {object} input
 * @param {string|null} input.beforeClient apply 之前浏览器半边的摘要（apply 前取）
 * @param {string} input.packageDir        已安装包目录（apply 之后）
 * @param {string} [input.releaseDir]      本次解包目录；给了才判断清单差异
 * @returns {{clientChanged: boolean, manifestChanged: boolean}}
 */
export function describeApply({ beforeClient, packageDir, releaseDir }) {
  const after = clientDigest(packageDir);
  // 只有真的取过「apply 前的摘要」才谈得上变化；两边都是 null 说明本来就没有 client.js。
  const clientChanged = beforeClient !== undefined && beforeClient !== after;
  const releaseManifest = releaseDir ? manifestDigest(releaseDir) : null;
  const manifestChanged = Boolean(releaseManifest) && releaseManifest !== manifestDigest(packageDir);
  return { clientChanged: Boolean(clientChanged), manifestChanged };
}

/**
 * 把补充判定压成给模型/命令行看的中文提示（没有提示时返回空串）。
 * @param {{clientChanged?: boolean, manifestChanged?: boolean}} extra
 * @returns {string}
 */
export function describeNotes(extra) {
  const lines = [];
  if (extra && extra.clientChanged) lines.push('浏览器半边已更新：刷新页面后界面才用上新代码。');
  if (extra && extra.manifestChanged) lines.push('注意：远端 package.json 与本地不同 —— 自更新不覆盖清单，需要重装插件并重启 DSH。');
  return lines.length ? lines.join('\n') + '\n' : '';
}
