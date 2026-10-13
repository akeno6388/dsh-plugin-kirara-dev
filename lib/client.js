/**
 * @kirara/dsh-plugin-kirara-dev —— 浏览器半边（DSH 插件管理页里的自更新入口）
 * ============================================================================
 *
 * 这是 DSH 客户端插件的 **经典脚本** 产物（不是 ESM），约定与本地主题插件一致：
 *   - 整段代码包在一个 IIFE 里；
 *   - 内部**恰好一次** window.__ModuleLoader__.load(...) 调用；
 *   - id 必须等于包名（@kirara/dsh-plugin-kirara-dev）；
 *   - 不写 import/export，依赖通过 factory 的 require 参数取（react 是平台种子模块）。
 *
 * 它往「插件管理」页贡献三处（槽位契约里为第三方插件预留的公共贡献点）：
 *   - plugins.detail.badge   ：标题旁的版本/更新徽标；
 *   - plugins.detail.actions ：页头按钮（检查更新 / 同步更新）；
 *   - plugins.detail.section ：页尾区段（提交信息、更新日志、回滚）。
 *
 * 三处都只在「当前详情页就是本插件的 bundle」时渲染，别的插件页一律返回 null。
 * 所有网络都打到宿主半边（lib/index.js）注册的同源路由上：
 *   GET  <route>/state     → 状态
 *   POST <route>/check     → 检查远端
 *   POST <route>/sync      → 同步并热重载
 *   POST <route>/rollback  → 回滚到同步前
 * routePath 由宿主首屏注入的全局 __KIRARA_DEV_UPDATE__ 提供（客户端读不到插件配置）。
 */

(function () {
  "use strict";

  var PKG_NAME = "@kirara/dsh-plugin-kirara-dev";
  var GLOBAL_KEY = "__KIRARA_DEV_UPDATE__";
  var DEFAULT_ROUTE = "/kirara-dev-update";
  var POLL_MS = 2500;

  window.__ModuleLoader__.load({
    id: PKG_NAME,
    factory: function (require) {
      var React = require("react");
      var h = React.createElement;

      // ── 路由 ────────────────────────────────────────────────────────────────
      function routeBase() {
        var injected = window[GLOBAL_KEY];
        var path =
          injected && typeof injected.routePath === "string" && injected.routePath
            ? injected.routePath
            : DEFAULT_ROUTE;
        return path.replace(/\/+$/, "");
      }

      // ── 一份极小的共享状态（三个槽位组件都看它） ─────────────────────────────
      var store = { data: null, error: null, pending: null, listeners: [] };

      function notify() {
        for (var i = 0; i < store.listeners.length; i += 1) {
          try {
            store.listeners[i]();
          } catch (error) {
            /* 单个订阅者出错不影响其它订阅者 */
          }
        }
      }

      function sameTopic(subject) {
        return !!(subject && subject.kind === "bundle" && subject.pkg && subject.pkg.name === PKG_NAME);
      }

      function refresh() {
        return fetch(routeBase() + "/state", { cache: "no-store" })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(function (data) {
            store.data = data;
            store.error = null;
            notify();
            return data;
          })
          .catch(function (error) {
            store.error = String((error && error.message) || error);
            notify();
            return null;
          });
      }

      function act(action) {
        store.pending = action;
        notify();
        return fetch(routeBase() + "/" + action, {
          method: "POST",
          headers: { "content-type": "application/json" },
        })
          .then(function (response) {
            return response.json().catch(function () {
              return null;
            });
          })
          .then(function (data) {
            if (data) store.data = data;
            store.error = null;
            notify();
            return data;
          })
          .catch(function (error) {
            store.error = String((error && error.message) || error);
            notify();
            return null;
          })
          .then(function (data) {
            store.pending = null;
            notify();
            // 下载/解包要几秒到几十秒，交回轮询去追进度。
            setTimeout(refresh, 800);
            return data;
          });
      }

      function useUpdateState() {
        var pair = React.useState(0);
        var setTick = pair[1];
        React.useEffect(function () {
          var listener = function () {
            setTick(function (value) {
              return value + 1;
            });
          };
          store.listeners.push(listener);
          return function () {
            var index = store.listeners.indexOf(listener);
            if (index >= 0) store.listeners.splice(index, 1);
          };
        }, []);
        return store;
      }

      // ── 展示用小工具 ────────────────────────────────────────────────────────
      function shortSha(sha) {
        return typeof sha === "string" && sha ? sha.slice(0, 8) : "—";
      }

      function timeLabel(iso) {
        if (!iso) return "从未";
        var date = new Date(iso);
        if (isNaN(date.getTime())) return String(iso);
        return date.toLocaleString();
      }

      var COLORS = {
        ok: "#1a7f37",
        warn: "#9a6700",
        bad: "#b42318",
        idle: "#57606a",
      };

      function pill(text, color, extra) {
        return h(
          "span",
          {
            style: Object.assign(
              {
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "1px 8px",
                borderRadius: "999px",
                border: "1px solid " + color,
                color: color,
                fontSize: "12px",
                lineHeight: "18px",
                whiteSpace: "nowrap",
              },
              extra || {},
            ),
          },
          text,
        );
      }

      function button(label, onClick, options) {
        var opts = options || {};
        return h(
          "button",
          {
            type: "button",
            onClick: onClick,
            disabled: !!opts.disabled,
            title: opts.title || label,
            style: {
              padding: "4px 12px",
              borderRadius: "6px",
              border: "1px solid " + (opts.primary ? "#1f6feb" : "#d0d7de"),
              background: opts.primary ? "#1f6feb" : "transparent",
              color: opts.primary ? "#ffffff" : "inherit",
              fontSize: "13px",
              cursor: opts.disabled ? "default" : "pointer",
              opacity: opts.disabled ? 0.6 : 1,
            },
          },
          label,
        );
      }

      // ── 槽位一：标题徽标 ────────────────────────────────────────────────────
      function UpdateBadge(props) {
        var state = useUpdateState();
        if (!sameTopic(props.subject)) return null;
        var data = state.data;
        if (state.error && !data) return pill("更新状态不可用", COLORS.bad);
        if (!data) return pill("更新：读取中", COLORS.idle);
        if (data.busy === "syncing") return pill("正在同步…", COLORS.warn);
        if (data.busy === "checking") return pill("正在检查…", COLORS.warn);
        if (data.updateAvailable) {
          return pill("有新版本 " + shortSha(data.remote && data.remote.sha), COLORS.warn);
        }
        if (data.remote && data.remote.error) return pill("检查失败", COLORS.bad);
        if (data.remote && data.remote.sha) return pill("已是最新", COLORS.ok);
        return pill("未检查更新", COLORS.idle);
      }

      // ── 槽位二：页头按钮 ────────────────────────────────────────────────────
      function UpdateActions(props) {
        var state = useUpdateState();
        if (!sameTopic(props.subject)) return null;
        var data = state.data || {};
        var busy = !!state.pending || data.busy === "syncing" || data.busy === "checking";
        var hasUpdate = !!data.updateAvailable;
        return h(
          "span",
          { style: { display: "inline-flex", gap: "8px", alignItems: "center" } },
          button(
            state.pending === "check" ? "检查中…" : "检查更新",
            function () {
              act("check");
            },
            { disabled: busy, title: "只查询 GitHub 上的最新提交，不修改任何文件" },
          ),
          button(
            state.pending === "sync" || data.busy === "syncing" ? "同步中…" : hasUpdate ? "同步更新" : "同步最新",
            function () {
              act("sync");
            },
            {
              disabled: busy,
              primary: hasUpdate,
              title: "从 GitHub 拉取最新提交并当场热重载（不重启 DSH、不动 pnpm）",
            },
          ),
        );
      }

      // ── 槽位三：页尾区段 ────────────────────────────────────────────────────
      function row(label, value) {
        return h(
          "div",
          { style: { display: "flex", gap: "12px", padding: "2px 0", fontSize: "13px" } },
          h("span", { style: { minWidth: "88px", color: COLORS.idle } }, label),
          h("span", { style: { wordBreak: "break-all" } }, value),
        );
      }

      function levelColor(level) {
        if (level === "error") return COLORS.bad;
        if (level === "warn") return COLORS.warn;
        return COLORS.idle;
      }

      function UpdateSection(props) {
        var state = useUpdateState();
        if (!sameTopic(props.subject)) return null;
        var data = state.data;
        if (!data) {
          return h(
            "section",
            { style: { marginTop: "16px" } },
            h("h4", { style: { margin: "0 0 6px" } }, "GitHub 更新"),
            h("p", { style: { margin: 0, fontSize: "13px", color: COLORS.idle } }, state.error ? "宿主半边没响应：" + state.error : "正在读取更新状态…"),
          );
        }
        var remote = data.remote || {};
        var logs = Array.isArray(data.log) ? data.log : [];
        return h(
          "section",
          { style: { marginTop: "16px" } },
          h(
            "h4",
            { style: { margin: "0 0 8px", display: "flex", alignItems: "center", gap: "8px" } },
            "GitHub 更新",
            data.updateAvailable ? pill("有新版本", COLORS.warn) : data.current && data.current.sha ? pill("已是最新", COLORS.ok) : pill("未知", COLORS.idle),
          ),
          row("仓库", data.repo + " (" + data.channel + ")"),
          row("当前提交", shortSha(data.current && data.current.sha) + (data.current && data.current.source === "release" ? "（已同步）" : "（随包安装）")),
          row("远端提交", remote.sha ? shortSha(remote.sha) + (remote.message ? " · " + remote.message : "") : remote.error ? "检查失败：" + remote.error : "未检查"),
          row("上次检查", timeLabel(remote.checkedAt)),
          row("最近应用", timeLabel(data.current && data.current.at)),
          row("产物目录", data.store),
          h(
            "div",
            { style: { display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" } },
            button("刷新状态", function () { refresh(); }, {}),
            button(
              data.previous && data.previous.backupDir ? "回滚到上一版" : "回滚（无备份）",
              function () { act("rollback"); },
              { disabled: !(data.previous && data.previous.backupDir) || !!state.pending || data.busy === "syncing", title: "把包目录还原成同步前那一份，并热重载" },
            ),
          ),
          data.updateAvailable
            ? h("p", { style: { margin: "8px 0 0", fontSize: "12px", color: COLORS.idle } }, "点「同步更新」后：下载 → 解包 → 覆盖包目录（旧版本自动备份）→ 宿主当场热重载；浏览器这半边如需新代码，刷新页面即可。")
            : null,
          logs.length
            ? h(
                "div",
                { style: { marginTop: "10px" } },
                h("div", { style: { fontSize: "12px", color: COLORS.idle, marginBottom: "4px" } }, "更新日志（最近 " + logs.length + " 条）"),
                h(
                  "div",
                  { style: { maxHeight: "140px", overflow: "auto", fontFamily: "ui-monospace, monospace", fontSize: "12px", lineHeight: "18px" } },
                  logs.map(function (entry, index) {
                    return h(
                      "div",
                      { key: index, style: { color: levelColor(entry.level) } },
                      "[" + String(entry.at || "").slice(11, 19) + "] " + entry.text,
                    );
                  }),
                ),
              )
            : null,
        );
      }

      // ── 插件入口 ────────────────────────────────────────────────────────────
      function apply(ctx) {
        ctx.slots.inject("plugins.detail.badge", function () {
          return ctx.slots.register({ name: "plugins.detail.badge", id: "kirara-dev-update", order: 60 }, UpdateBadge);
        });
        ctx.slots.inject("plugins.detail.actions", function () {
          return ctx.slots.register({ name: "plugins.detail.actions", id: "kirara-dev-update", order: 60 }, UpdateActions);
        });
        ctx.slots.inject("plugins.detail.section", function () {
          return ctx.slots.register({ name: "plugins.detail.section", id: "kirara-dev-update", order: 60 }, UpdateSection);
        });
        ctx.effect(function () {
          var timer = setInterval(refresh, POLL_MS);
          refresh();
          return function () {
            clearInterval(timer);
            store.listeners.length = 0;
          };
        }, "kirara-dev:update-client");
      }

      return { inject: ["slots"], apply: apply };
    },
  });
})();
