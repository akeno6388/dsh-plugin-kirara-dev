/**
 * @kirara/dsh-plugin-kirara-dev —— 宿主半边【引导层】
 * ============================================================================
 *
 * 这个文件**刻意保持很薄且几乎不变**，它只做四件事：
 *
 *   1. 把真正的实现（lib/impl.js）挂成自己的子 fiber —— 实现可以整体换掉，
 *      引导层不动，所以「换实现」不需要重启 DSH；
 *   2. 跑自更新状态机（查 GitHub → 下产物 → 解包 → 覆盖包目录 → 备份）；
 *   3. 暴露同源 HTTP 路由给浏览器半边（看状态 / 检查 / 同步 / 回滚）；
 *   4. 同步成功后：dispose 旧的实现 fiber，用 ?v=<sha> 重新 import 并挂载新的。
 *
 * 为什么是这个结构（而不是依赖 DSH 的 HMR）：
 *   - DSH 的模块级 HMR 必须**启动前**配好根目录，且官方文档明确写着
 *     「替换已安装包的版本仍需重启」；
 *   - 实测（2026-10-13）在独立进程里给 dsh-hmr 配 root 后改文件也没有触发重载。
 *   而「子 fiber 换实现」这条路是在 cordis 公共 API 上成立的，实测可用：
 *   import(pathToFileURL(impl).href + '?v=' + sha) → ctx.plugin(mod, config)
 *   → 旧 scope.dispose()；三条都验证过（apply 收到配置、旧 effect 被回收、新 effect 生效）。
 *
 * 为什么配置里只有 update* 字段：schemastery 的 object 校验**保留未知键**，
 * 所以实现层自己的配置字段会原样透传，引导层不需要（也不应该）复制一份实现层的 schema。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { BUNDLED_SHA } from './build-info.js';
import { DEFAULT_CHECK_INTERVAL_MS, createLogBuffer, createUpdater } from './update.js';

export const name = 'kirara-dev';

/** 包名与仓库：自更新的身份标识（种子 [owner, repo] 与包名必须与 package.json 一致）。 */
const PKG_NAME = '@kirara/dsh-plugin-kirara-dev';
const REPO = 'akeno6388/dsh-plugin-kirara-dev';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const IMPL_FILE = join(PACKAGE_DIR, 'lib', 'impl.js');
const RELEASE_FILE = join(PACKAGE_DIR, 'release.json');

/** 首屏注入给浏览器半边的全局名（客户端 lib/client.js 里必须用同一个字面量）。 */
export const GLOBAL_KEY = '__KIRARA_DEV_UPDATE__';
const DEFAULT_ROUTE_PATH = '/kirara-dev-update';

/**
 * 引导层配置：只声明自更新字段。
 * ⚠️ 实现层（lib/impl.js）的字段（workspaceRoot / buildTimeoutMs / …）不在这里重复声明，
 *    它们靠 schemastery 的未知键透传原样到达实现层。
 */
export const Config = z.object({
  /** 跟随哪个分支/标签（默认 main）。 */
  updateChannel: z.string().default('main'),
  /** 启动后是否自动检查一次更新（默认 true；只查不装）。 */
  updateAutoCheck: z.boolean().default(true),
  /** 更新产物与备份的根目录（默认 <DSH_HOME>/kirara-plugins/<包名>）。 */
  updateStoreRoot: z.string().default(''),
  /** 浏览器半边用的路由前缀。 */
  updateRoutePath: z.string().default(DEFAULT_ROUTE_PATH),
});

function normalizeRoutePath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return DEFAULT_ROUTE_PATH;
  return ('/' + raw.replace(/^\/+|\/+$/g, '')).replace(/\/{2,}/g, '/') || DEFAULT_ROUTE_PATH;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 已落地的实现对应哪个提交：包目录里 release.json 说了算，否则就是随包那一份。 */
function resolveAppliedSha() {
  if (!existsSync(RELEASE_FILE)) return BUNDLED_SHA;
  try {
    const release = JSON.parse(readFileSync(RELEASE_FILE, 'utf8'));
    return typeof release.sha === 'string' && release.sha ? release.sha : BUNDLED_SHA;
  } catch {
    return BUNDLED_SHA;
  }
}

export async function apply(ctx, config) {
  const routePath = normalizeRoutePath(config.updateRoutePath);
  const log = createLogBuffer();
  const updater = createUpdater({
    pkgName: PKG_NAME,
    repo: REPO,
    packageDir: PACKAGE_DIR,
    bundledSha: BUNDLED_SHA,
    config,
    log,
  });

  let mountedSha = resolveAppliedSha();
  let scope = null;

  const importImpl = (sha) => import(pathToFileURL(IMPL_FILE).href + '?v=' + encodeURIComponent(sha || 'bundled'));

  /** 挂载一份实现，并把它记成当前实现。 */
  const mount = async (sha) => {
    const mod = await importImpl(sha);
    const mounted = ctx.plugin(mod, config);
    await mounted;
    scope = mounted;
    mountedSha = sha;
    return mounted;
  };

  /**
   * 热重载：先 import 新版（失败就不动现场）→ dispose 旧实现 → 挂载新实现。
   * 新实现挂载失败时自动把旧实现装回去，并把错误抛给调用方。
   */
  const reload = async (sha) => {
    const nextMod = await importImpl(sha);
    const previousSha = mountedSha;
    const previousScope = scope;
    scope = null;
    if (previousScope) {
      try {
        previousScope.dispose();
      } catch (error) {
        log.push('warn', '旧实现卸载时报错：' + String((error && error.message) || error));
      }
    }
    try {
      const mounted = ctx.plugin(nextMod, config);
      await mounted;
      scope = mounted;
      mountedSha = sha;
      log.push('info', '已热重载到 ' + String(sha || 'bundled').slice(0, 8));
    } catch (error) {
      log.push('error', '新版本挂载失败，回滚到 ' + String(previousSha || 'bundled').slice(0, 8) + '：' + String((error && error.message) || error));
      const fallback = await importImpl(previousSha);
      const mounted = ctx.plugin(fallback, config);
      await mounted;
      scope = mounted;
      mountedSha = previousSha;
      throw error;
    }
  };

  // 1) 先把实现挂上：此时插件的工具/路由/配置全部就位。
  await mount(mountedSha);

  // 2) 自更新路由 + 首屏全局（挂在引导层上，所以换实现不会把更新入口弄丢）。
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const isSameOrigin = (req) => {
        const origin = req.headers && req.headers.origin;
        const host = req.headers && req.headers.host;
        if (!origin || !host) return true;
        try {
          return new URL(origin).host === host;
        } catch {
          return false;
        }
      };

      const runSync = async (sha) => {
        try {
          const result = await updater.sync(sha ? { sha } : {});
          if (result.changed) await reload(result.sha);
          return result;
        } catch (error) {
          log.push('error', '同步流程失败：' + String((error && error.message) || error));
          return { changed: false, error: String((error && error.message) || error) };
        }
      };

      const runRollback = async () => {
        try {
          const result = await updater.rollback();
          await reload(result.sha);
          return result;
        } catch (error) {
          log.push('error', '回滚流程失败：' + String((error && error.message) || error));
          return { changed: false, error: String((error && error.message) || error) };
        }
      };

      const disposeRoute = child.webServer.register({
        kind: 'prefix',
        path: routePath,
        handler: async (req, res) => {
          try {
            const raw = req.url || routePath;
            const queryIndex = raw.indexOf('?');
            const pathname = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
            const suffix = pathname.slice(routePath.length).replace(/^\/+/, '');
            const method = (req.method || 'GET').toUpperCase();

            if (method === 'GET' || method === 'HEAD') {
              if (suffix === '' || suffix === 'state' || suffix === 'state.json') {
                sendJson(res, 200, updater.status());
                return;
              }
              sendJson(res, 404, { error: 'unknown path: ' + suffix });
              return;
            }

            if (method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            if (!isSameOrigin(req)) {
              sendJson(res, 403, { error: 'cross-origin request rejected' });
              return;
            }

            if (suffix === 'check' || suffix === 'check.json') {
              try {
                await updater.check();
              } catch (error) {
                log.push('warn', '检查更新失败：' + String((error && error.message) || error));
              }
              sendJson(res, 200, updater.status());
              return;
            }
            if (suffix === 'sync') {
              // 下载可能几十秒：立刻回 202，让浏览器半边轮询 /state 看进度。
              void runSync();
              sendJson(res, 202, updater.status());
              return;
            }
            if (suffix === 'rollback') {
              void runRollback();
              sendJson(res, 202, updater.status());
              return;
            }
            sendJson(res, 404, { error: 'unknown action: ' + suffix });
          } catch (error) {
            sendJson(res, 500, { error: String((error && error.message) || error) });
          }
        },
      });

      const disposeInject = child.on('webserver/index-inject', (table) => {
        table.push({
          kind: 'global',
          name: GLOBAL_KEY,
          value: { pkg: PKG_NAME, routePath, channel: updater.status().channel, version: BUNDLED_SHA },
        });
      });

      // 3) 自动检查：启动后一次（不装），之后每 6 小时一次。
      const autoCheck = config.updateAutoCheck !== false;
      const timer = autoCheck
        ? setInterval(() => {
            void updater.check({ silent: true }).catch(() => {});
          }, DEFAULT_CHECK_INTERVAL_MS)
        : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      if (autoCheck) void updater.check({ silent: true }).catch(() => {});

      return () => {
        if (timer) clearInterval(timer);
        disposeInject();
        disposeRoute();
      };
    }, 'kirara-dev:update-route');
  });

  // 4) 插件卸载时把实现一并卸掉。
  ctx.effect(() => () => {
    if (scope) {
      try {
        scope.dispose();
      } catch {
        /* 卸载期的异常不再向上抛 */
      }
      scope = null;
    }
  }, 'kirara-dev:impl');
}

export { GLOBAL_KEY as UPDATE_GLOBAL_KEY };
