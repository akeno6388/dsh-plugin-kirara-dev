/**
 * @kirara 插件自更新内核（宿主半边，无第三方依赖）
 * ============================================================================
 *
 * 目标：让用户在 DSH 的「插件管理」页面上点一下，就把插件同步到 GitHub 上的
 * 最新提交，并且**当场生效**（不重启 DSH、不碰 pnpm / lockfile）。
 *
 * 分工：
 *   - 本文件：查远端、下产物、解包、落盘、备份、回滚、状态机。
 *   - lib/index.js（引导层）：把实现挂成子 fiber，并在同步成功后 dispose 旧的、
 *     用 ?v=<sha> 重新 import 新的 —— 这就是「实时生效」的全部机制。
 *   - lib/client.js（浏览器半边）：在插件详情页渲染按钮 / 徽标 / 更新区段。
 *
 * ★ 本文件在 @kirara/dsh-plugin-kirara-dev 与 @kirara/dsh-plugin-kirara-theme
 *   两个仓库里是**逐字节相同的副本**，改动必须两边同步（各仓库的
 *   scripts/check-kernel-parity.mjs 会校验，避免悄悄漂移）。
 *
 * 为什么不用 git：桌面端宿主进程里没有 system git（宿主日志 systemGit=missing），
 * 而 Node 的 fetch 已被 DSH 的 http-proxy 统一接好代理策略，所以更新一律走 HTTPS。
 *
 * 为什么不用 pnpm：包管理器替换版本属于启动期操作（DSH 官方文档明确写着重启），
 * 而这里要的是运行期热切换；产物直接落到插件自己的包目录，pnpm 完全不参与。
 */

import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** 更新产物/备份的根目录名（<DSH_HOME>/kirara-plugins/<插件>）。 */
export const STORE_DIRNAME = 'kirara-plugins';
/** 会被同步进包目录的顶层目录（引导层 lib/index.js 也在其中，保持包自洽）。 */
const SYNCED_DIRS = ['lib', 'locale'];
/**
 * 实现层的路径：只有它的提交才算「有更新」。
 *
 * 为什么是 `lib/` 而不是 `lib/impl.js`：同步时被**整体替换**的是整个 `lib/`，
 * 而 `lib/` 里除了 impl.js 还有 index.js（引导层）、client.js（界面）、update.js（内核）。
 * 只盯 impl.js 会漏掉「只改了 index.js / client.js」的提交 —— 那种提交被当成
 * 「已是最新」，而强制 sync 到旧 sha 时又会把新加的文件（例如 client.js）删掉。
 */
export const IMPL_PATH = 'lib';
/**
 * 发版印章文件：写它的提交只推进 `lib/` 的 tip，并不代表代码变了。
 * 判定时必须排除，否则每次发版后都会立刻提示「有新版本」。
 */
export const STAMP_PATH = 'lib/build-info.js';

/**
 * 一组变更文件里有没有「实现层实质改动」。
 * 印章提交（`chore: 写发版印章 BUNDLED_SHA`）与纯文档提交都应当判定为「没有」。
 * 拿不到文件清单时返回 true：宁可多提示一次，也不要漏掉真更新。
 */
export function hasRelevantChange(files) {
  if (!Array.isArray(files)) return true;
  return files.some((entry) => {
    const name = String((entry && entry.filename) || entry || '');
    return name.startsWith(IMPL_PATH + '/') && name !== STAMP_PATH;
  });
}
const HISTORY_LIMIT = 12;
const LOG_LIMIT = 40;

/** 简单日志环形缓冲：给 UI 看「刚才发生了什么」。 */
export function createLogBuffer(limit = LOG_LIMIT) {
  const items = [];
  return {
    push(level, text) {
      items.push({ at: new Date().toISOString(), level, text: String(text).slice(0, 400) });
      if (items.length > limit) items.splice(0, items.length - limit);
    },
    list() {
      return items.slice(-12).reverse();
    },
  };
}

/** 解析更新根目录。优先级：显式配置 > DSH_HOME > ~/.dsh。 */
export function resolveStoreRoot(config) {
  const custom = typeof config?.updateStoreRoot === 'string' ? config.updateStoreRoot.trim() : '';
  if (custom) return resolve(custom);
  const home = (process.env.DSH_HOME || process.env.DSH_HOME_DIR || '').trim();
  if (home) return join(resolve(home), STORE_DIRNAME);
  return join(homedir(), '.dsh', STORE_DIRNAME);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 极简 tar.gz 解包：只认 git archive 会产生的东西（ustar + pax 扩展头 + GNU 长名）。
 * 不引入 tar 依赖，是为了让插件保持「零运行期依赖」，否则 pnpm 会把它装进 profile。
 */
export function extractTarGz(buffer, destDir, options = {}) {
  const strip = options.strip === undefined ? 1 : options.strip;
  const tar = gunzipSync(buffer);
  const files = [];
  let offset = 0;
  let pendingName = null;

  const readString = (start, length) => {
    const raw = tar.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.toString('utf8', 0, end === -1 ? raw.length : end).trim();
  };
  const readOctal = (start, length) => {
    const text = readString(start, length).replace(/[^0-7]/g, '');
    return text ? parseInt(text, 8) : 0;
  };

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = readOctal(offset + 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const bodyStart = offset + 512;
    const body = tar.subarray(bodyStart, bodyStart + size);
    const name = readString(offset, 100);
    const prefix = readString(offset + 345, 155);
    offset = bodyStart + Math.ceil(size / 512) * 512;

    if (type === 'L' || type === 'K') {
      pendingName = body.toString('utf8').replace(/\0/g, '').trim();
      continue;
    }
    if (type === 'x' || type === 'g') {
      const text = body.toString('utf8');
      const match = /(?:^|\n)\d+ path=([^\n]+)\n?$/.exec(text.trimStart());
      if (match) pendingName = match[1].trim();
      continue;
    }
    if (type !== '0' && type !== '\0') continue;

    const fullName = pendingName || (prefix ? prefix + '/' + name : name);
    pendingName = null;
    const segments = fullName.split('/').filter((part) => part !== '' && part !== '.');
    if (segments.some((part) => part === '..')) continue;
    const parts = segments.slice(strip);
    if (parts.length === 0) continue;
    const target = join(destDir, ...parts);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    files.push(posix.join(...parts));
  }
  return files;
}

/** 带超时的 fetch（DSH 宿主已统一代理策略，这里只需普通 fetch）。 */
async function request(url, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
  const parse = options.parse === undefined ? 'bytes' : options.parse;
  const headers = { 'user-agent': 'kirara-dsh-plugin-updater' };
  if (options.accept) headers.accept = options.accept;
  const response = await fetch(url, {
    method: options.method || 'GET',
    redirect: 'follow',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText + ' @ ' + url);
  if (parse === 'json') return await response.json();
  if (parse === 'text') return await response.text();
  return Buffer.from(await response.arrayBuffer());
}

/**
 * 创建一个更新器。
 *
 * @param {object} app
 * @param {string} app.pkgName     包名（也是状态里的身份标识）
 * @param {string} app.repo        owner/repo
 * @param {string} app.packageDir  已安装包目录（同步产物落到这里）
 * @param {string} [app.bundledSha] 随包安装的那份对应的提交（发版时印章）
 * @param {object} [app.config]    插件配置（updateChannel / updateStoreRoot / updateEndpoints）
 * @param {object} [app.log]       createLogBuffer() 的返回值
 */
export function createUpdater(app) {
  const pkgName = app.pkgName;
  const repo = app.repo;
  const packageDir = app.packageDir;
  const bundledSha = app.bundledSha === undefined ? null : app.bundledSha;
  const config = app.config || {};
  const log = app.log || createLogBuffer();
  const slug = pkgName.replace(/^@/, '').replace(/[\\/]/g, '-');
  const channel = (typeof config.updateChannel === 'string' && config.updateChannel.trim()) || 'main';
  const storeRoot = resolveStoreRoot(config);
  const pluginStore = join(storeRoot, slug);
  const paths = {
    storeRoot,
    pluginStore,
    releases: join(pluginStore, 'releases'),
    backups: join(pluginStore, 'backups'),
    state: join(pluginStore, 'state.json'),
  };
  const endpoints = {
    api: 'https://api.github.com',
    codeload: 'https://codeload.github.com',
    git: 'https://github.com',
    ...(config.updateEndpoints && typeof config.updateEndpoints === 'object' ? config.updateEndpoints : {}),
  };

  let busy = 'idle';
  let lastError = null;

  const emptyState = () => ({
    pkg: pkgName,
    repo,
    channel,
    current: { sha: bundledSha, source: 'bundled', at: null },
    previous: null,
    remote: null,
    history: [],
  });

  const readState = () => {
    const state = readJson(paths.state, null);
    if (!state || state.pkg !== pkgName) return emptyState();
    return { ...emptyState(), ...state };
  };
  const saveState = (state) => writeJsonAtomic(paths.state, state);

  /**
   * 远端「实现层」的最新提交。
   *
   * 为什么按路径过滤：跟着 main 的仓库，纯文档提交也会把 HEAD 往前推；若拿 HEAD 当判据，
   * 用户每看到一次文档提交就被催一次「有新版本」，同步下来却只改了 README。
   * /commits?path=lib 拿到的正是「实现层最后一次变更」。注意它可能是**印章提交**
   * （`lib/build-info.js` 也在 lib/ 里），所以「有没有更新」不能只看 sha 是否相等，
   * 还要看差异里有没有实现层实质改动（见 hasRelevantChange / fetchRangeRelevance）。
   * 网络/限额异常时依次退回 HEAD，再退回 git 协议的 info/refs（后者不吃 API 限额）。
   */
  async function fetchRemoteSha() {
    try {
      const info = await request(
        endpoints.api + '/repos/' + repo + '/commits?path=' + encodeURIComponent(IMPL_PATH) +
          '&sha=' + encodeURIComponent(channel) + '&per_page=1',
        { accept: 'application/vnd.github+json', timeoutMs: 12000, parse: 'json' },
      );
      const scoped = Array.isArray(info) ? info[0] : info;
      if (scoped && typeof scoped.sha === 'string') {
        const commit = scoped.commit || {};
        return {
          sha: scoped.sha,
          message: String(commit.message || '').split('\n')[0].slice(0, 200),
          date: (commit.committer && commit.committer.date) || (commit.author && commit.author.date) || null,
          scope: IMPL_PATH,
        };
      }
      throw new Error('GitHub API 的按路径查询没有返回 sha');
    } catch (scopedError) {
      try {
        const info = await request(endpoints.api + '/repos/' + repo + '/commits/' + encodeURIComponent(channel), {
          accept: 'application/vnd.github+json',
          timeoutMs: 12000,
          parse: 'json',
        });
        if (info && typeof info.sha === 'string') {
          const commit = info.commit || {};
          return {
            sha: info.sha,
            message: String(commit.message || '').split('\n')[0].slice(0, 200),
            date: (commit.committer && commit.committer.date) || (commit.author && commit.author.date) || null,
          };
        }
        throw new Error('GitHub API 返回里没有 sha');
      } catch (apiError) {
        try {
          const text = await request(endpoints.git + '/' + repo + '.git/info/refs?service=git-upload-pack', {
            accept: '*/*',
            timeoutMs: 12000,
            parse: 'text',
          });
          const escaped = channel.replace(/[.*+?^$|{}()[\]\\]/g, '\\$&');
          const match = new RegExp('([0-9a-f]{40}) refs/heads/' + escaped + '(?![\\w/-])').exec(text);
          if (!match) throw new Error('info/refs 里没有 refs/heads/' + channel);
          return { sha: match[1], message: '', date: null, via: 'git-upload-pack' };
        } catch (gitError) {
          throw new Error('无法访问 GitHub：' + scopedError.message + ' / ' + apiError.message + ' / ' + gitError.message);
        }
      }
    }
  }

  /**
   * 本地这份与远端 tip 之间的差异里，`lib/` 有没有实质改动。
   *
   * 用 compare 而不是只看远端那一个提交的 files：两者之间可能夹着好几个提交，
   * 只看 tip 会漏掉更早的实现层改动（tip 恰好是文档提交时就会误判成「没有更新」）。
   */
  async function fetchRangeRelevance(base, head) {
    try {
      const info = await request(
        endpoints.api + '/repos/' + repo + '/compare/' +
          encodeURIComponent(base) + '...' + encodeURIComponent(head),
        { accept: 'application/vnd.github+json', timeoutMs: 12000, parse: 'json' },
      );
      return hasRelevantChange(info && info.files);
    } catch {
      // 比对失败（base 已不在仓库里、API 限额、离线）→ 按「有改动」走，避免漏更新。
      return true;
    }
  }

  function updateAvailable(state) {
    const remoteSha = state.remote && state.remote.sha;
    if (!remoteSha) return false;
    if (remoteSha === (state.current && state.current.sha)) return false;
    // 远端 tip 变了，但差异里没有实现层改动（只动了印章或文档）⇒ 不算更新。
    return state.remote.relevant !== false;
  }

  function status() {
    const state = readState();
    return {
      pkg: pkgName,
      repo,
      channel,
      packageDir,
      busy,
      lastError,
      current: state.current,
      previous: state.previous,
      remote: state.remote,
      updateAvailable: updateAvailable(state),
      store: pluginStore,
      log: log.list ? log.list() : [],
    };
  }

  async function check(options = {}) {
    if (busy !== 'idle') return status();
    busy = 'checking';
    lastError = null;
    try {
      const remote = await fetchRemoteSha();
      const state = readState();
      const currentSha = state.current && state.current.sha;
      // 只有两端不同才值得多花一次 compare 请求；相同就是「已是最新」。
      if (remote.sha && currentSha && remote.sha !== currentSha) {
        remote.relevant = await fetchRangeRelevance(currentSha, remote.sha);
      }
      state.remote = { ...remote, checkedAt: new Date().toISOString(), error: null };
      saveState(state);
      if (!options.silent) {
        const note = remote.relevant === false ? '（只动了印章/文档，不算更新）' : '';
        log.push('info', '检查更新：远端 ' + remote.sha.slice(0, 8) + (remote.message ? ' ' + remote.message : '') + note);
      }
      return status();
    } catch (error) {
      lastError = String((error && error.message) || error);
      const state = readState();
      state.remote = { ...(state.remote || {}), checkedAt: new Date().toISOString(), error: lastError };
      saveState(state);
      log.push('warn', '检查更新失败：' + lastError);
      throw error;
    } finally {
      busy = 'idle';
    }
  }

  /** 把发行目录里的内容覆盖进已安装的包目录，并备份被覆盖的旧文件。 */
  function applyRelease(releaseDir, sha, state) {
    const backupDir = join(paths.backups, ((state.current && state.current.sha) || 'bundled') + '-' + Date.now());
    mkdirSync(backupDir, { recursive: true });
    for (const dir of SYNCED_DIRS) {
      const from = join(releaseDir, dir);
      if (!existsSync(from)) continue;
      const to = join(packageDir, dir);
      if (existsSync(to)) cpSync(to, join(backupDir, dir), { recursive: true });
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true });
    }
    mkdirSync(packageDir, { recursive: true });
    writeJsonAtomic(join(packageDir, 'release.json'), { sha, repo, channel, appliedAt: new Date().toISOString() });
    return backupDir;
  }

  function pruneBackups(keep) {
    try {
      const entries = readdirSync(paths.backups).map((name) => ({ name, at: statSync(join(paths.backups, name)).mtimeMs }));
      entries.sort((a, b) => b.at - a.at);
      for (const entry of entries.slice(keep)) rmSync(join(paths.backups, entry.name), { recursive: true, force: true });
    } catch {
      /* 备份清理失败不影响主流程 */
    }
  }

  /**
   * 同步到远端最新（或指定 sha）。返回 { changed, sha, ... }。
   * 只负责「把新代码落到包目录」，重新挂载由引导层完成。
   */
  async function sync(options = {}) {
    if (busy !== 'idle') throw new Error('已有更新任务在进行中');
    busy = 'syncing';
    lastError = null;
    try {
      const state = readState();
      let target = typeof options.sha === 'string' && options.sha.trim() ? options.sha.trim() : null;
      if (!target) {
        const remoteInfo = await fetchRemoteSha();
        state.remote = { ...remoteInfo, checkedAt: new Date().toISOString(), error: null };
        saveState(state);
        target = remoteInfo.sha;
      }
      if (state.current && state.current.sha === target) {
        log.push('info', '已是最新提交 ' + target.slice(0, 8) + '，无需同步');
        return { changed: false, sha: target, status: status() };
      }

      const releaseDir = join(paths.releases, target);
      const marker = join(releaseDir, '.kirara-release.json');
      if (!existsSync(marker)) {
        rmSync(releaseDir, { recursive: true, force: true });
        mkdirSync(releaseDir, { recursive: true });
        log.push('info', '下载 ' + repo + '@' + target.slice(0, 8) + ' …');
        const buffer = await request(endpoints.codeload + '/' + repo + '/tar.gz/' + target, {
          timeoutMs: 90000,
          accept: 'application/gzip, application/octet-stream',
        });
        const files = extractTarGz(buffer, releaseDir, { strip: 1 });
        if (files.length === 0) throw new Error('解包后没有任何文件');
        const manifestPath = join(releaseDir, 'package.json');
        if (!existsSync(manifestPath)) throw new Error('产物里没有 package.json（不是插件仓库？）');
        const manifest = readJson(manifestPath, {});
        if (manifest.name !== pkgName) throw new Error('产物包名是 ' + manifest.name + '，与 ' + pkgName + ' 不符');
        if (!existsSync(join(releaseDir, 'lib', 'impl.js'))) throw new Error('产物里没有 lib/impl.js（引导层找不到实现）');
        writeJsonAtomic(marker, {
          sha: target,
          sha256: sha256(buffer),
          bytes: buffer.length,
          files: files.length,
          downloadedAt: new Date().toISOString(),
        });
      } else {
        log.push('info', '复用已下载的 ' + target.slice(0, 8));
      }

      const backupDir = applyRelease(releaseDir, target, state);
      const next = {
        ...state,
        current: { sha: target, source: 'release', at: new Date().toISOString() },
        previous: {
          ...(state.current || { sha: null }),
          backupDir,
          replacedAt: new Date().toISOString(),
        },
        history: [
          ...(state.history || []),
          { sha: target, at: new Date().toISOString(), action: 'sync', backupDir },
        ].slice(-HISTORY_LIMIT),
      };
      saveState(next);
      pruneBackups(3);
      log.push('info', '已同步到 ' + target.slice(0, 8) + '，正在热重载');
      return { changed: true, sha: target, backupDir, status: status() };
    } catch (error) {
      lastError = String((error && error.message) || error);
      log.push('error', '同步失败：' + lastError);
      throw error;
    } finally {
      busy = 'idle';
    }
  }

  /** 回滚到同步前那一份（备份逐字节还原）。 */
  async function rollback() {
    if (busy !== 'idle') throw new Error('已有更新任务在进行中');
    busy = 'syncing';
    lastError = null;
    try {
      const state = readState();
      const backupDir = state.previous && state.previous.backupDir;
      if (!backupDir || !existsSync(backupDir)) throw new Error('没有可用的回滚备份');
      for (const dir of SYNCED_DIRS) {
        const from = join(backupDir, dir);
        if (!existsSync(from)) continue;
        const to = join(packageDir, dir);
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true });
      }
      const restored = (state.previous && state.previous.sha) || null;
      if (restored) {
        writeJsonAtomic(join(packageDir, 'release.json'), { sha: restored, repo, channel, appliedAt: new Date().toISOString() });
      } else {
        rmSync(join(packageDir, 'release.json'), { force: true });
      }
      const next = {
        ...state,
        // 回滚到「随包版本」（restored 就是印章提交）时仍然是 bundled，别标成 release，
        // 否则详情页会把它显示成「已同步」，自检脚本也会判失败。
        current: { sha: restored, source: restored && restored !== bundledSha ? 'release' : 'bundled', at: new Date().toISOString() },
        previous: null,
        history: [...(state.history || []), { sha: restored, at: new Date().toISOString(), action: 'rollback' }].slice(-HISTORY_LIMIT),
      };
      saveState(next);
      log.push('info', '已回滚到 ' + (restored ? restored.slice(0, 8) : '随包版本'));
      return { changed: true, sha: restored, status: status() };
    } catch (error) {
      lastError = String((error && error.message) || error);
      log.push('error', '回滚失败：' + lastError);
      throw error;
    } finally {
      busy = 'idle';
    }
  }

  return {
    paths,
    endpoints,
    log,
    readState,
    status,
    check,
    sync,
    rollback,
    updateAvailable,
    get busy() {
      return busy;
    },
  };
}

/** 更新检查的默认间隔（毫秒）：6 小时。 */
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
