# @kirara/dsh-plugin-kirara-dev

Kirara 多端项目（`kirara_server` / `kirara_-server-api` / `Kirara_Media`）的 **DSH 开发流程编排插件**。

它把「解读文档 → 定路线（可挂起提问）→ 开发 → 构建验证 → 实机验证清单 → 总结」这条流程做成模型可调用的工具，
并顺手解决原 VS Code Copilot 工作流的两个真实痛点：**记忆文件过大挤爆上下文**、**构建命令各端不一致且易踩坑**。

---

## 0. 给别人用：三步装上

> 本节面向 **不是作者本机** 的用户。作者自己的开发循环（`file:` 依赖 + `scripts/deploy.mjs`）见 §2。

**第 1 步 · 添加插件。** 侧栏 **插件** → **添加插件**，填入仓库地址：

```
git+https://github.com/akeno6388/dsh-plugin-kirara-dev.git
```

也接受 `https://github.com/akeno6388/dsh-plugin-kirara-dev`（DSH 认这个形式）和本地绝对路径。
命令行等价物：`dsh plugin --profile <profile> add <spec>`。

> ⚠️ 不要用 `github:owner/repo` 简写。pnpm 会把它改写成 `git+ssh://`，没配 GitHub SSH key 的机器
> 会直接 `Host key verification failed`。用显式的 `git+https://`。
>
> ⚠️ 国内网络访问 `github.com:443` 经常超时。Gitee 镜像地址同样可用。

**第 2 步 · 启用。** 安装完成界面点 **立即启用**（或回到插件列表打开该组合包的开关）。

**第 3 步 · 告诉它你的仓库在哪。** 插件默认按 `DSH_WORKSPACE` → 当前工作目录的顺序猜 Kirara 仓库根目录。
如果猜不中，在自己 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: kirara-dev
  config:
    workspaceRoot: 'D:\path\to\your\kirara-root'
    # ⚠️ 覆盖是整行替换，这里没写的字段会回落到插件内置默认值
```

改完**完全重启 DSH**（bundles 只在启动时读一次）。

### 你还需要自己准备什么

这个插件是**薄编排层**，它自己不含任何 Kirara 代码。要用起来你得先有 Kirara 三端仓库本身：

| 期望 | 前置条件 |
|---|---|
| `kirara_build` / `kirara_summary` | 本机能跑 `dotnet`（桌面端需 .NET 10 SDK + WinUI 3 工作负载）与 `gradlew.bat`（Android 端） |
| `kirara_verify` 的截图复核 | 一个支持图像的 chat 模型路由 |

### 兼容性

`peerDependencies` 声明为 `@deepseek-ai/dsh-tools@^0.2.0-rc.2`。实测语义：**适配 DSH 0.2.x 全系列**
（`0.2.0-rc.2` / `0.2.0` / `0.2.1` 都通过），`0.3.0` 起会被判 incompatible 并自动禁用。
换大版本后若仍想用，需要 `dsh plugin allow-version` 显式授权（有崩溃风险，插件本身没测过新版本）。

### 升级

**插件暂不支持自动更新**：先在插件页卸载，再用新地址重装一次。

### 换一条分发渠道：发到 npm

上面的 git 安装是当前推荐路径（无需注册、改动即直达）。若想改成 npm 注册表安装，需要先动三处，
否则 `npm publish` 会被直接拒绝：

| # | 要改什么 | 为什么 |
|---|---|---|
| 1 | 删掉 `package.json` 的 `"private": true` | 它是 `npm publish` 的硬性拦截（**不影响 git 安装**，后者照常可用） |
| 2 | 处理 `@kirara` 作用域 | npm 上 scoped 包必须有对应 organization 才能发布；不想建就把包名改成 `dsh-plugin-kirara-dev` 之类，并同步改 profile 依赖名与 `dsh.profile.bundles` |
| 3 | 加 `"publishConfig": { "access": "public" }` | 不加的话注册表按默认可见性处理，可能发成私有 |

发布后用户可以只填包名安装：`dsh-plugin-kirara-dev` 或 `@kirara/dsh-plugin-kirara-dev@0.1.0`。
DSH 会在 npm 官方源与 npmmirror 之间自动探测（国内可省一次手动选源）。

---

## 1. 它提供什么

| 工具 | 作用 | 关键价值 |
| --- | --- | --- |
| `kirara_start` | **一句话启动开发**：给定一句自然语言请求，一次返回涉及端 + 该先读哪几篇文档 + 各端构建命令 + 是否需实机验证 + 阻塞决策 | **整个流程的入口**；`mode=auto` 自动判 full/small，有阻塞项或涉界面时升级为 full |
| `kirara_profile` | 返回三端的项目画像 | **替代读取 153 KB 的 `AGENTS.md`**；直接给出实测可用的构建命令 + 各端硬约束 |
| `kirara_docs` | 在技术文档里按关键词检索（返回文件:行号 + 所属章节） | **渐进式披露**：文档最大 258 KB，按需取片段而不是整篇塞进上下文 |
| `kirara_route` | 把一句自然语言需求变成路线（涉及端/计划/决策点） | 小功能 `mode=small` 免实机（显式选 small 但涉界面时会提醒）；需要拍板时产出结构化 `decisions` |
| `kirara_build` | 跑真实构建，返回结构化结论（ok / 退出码 / 耗时 / 错误行 / 日志尾） | 在 DSH 宿主进程里跑，**不受 pwsh 沙箱 stdio 限制、不吃工具超时**；命令按端预置，绕开已知坑 |
| `kirara_verify` | 产出分步真机测试清单（步骤 + 预期结果）；传 `screenshots` 可附带**视觉复核协议**，交给 `ecnu-plus` 看实机截图 | 项目约定**不写单元测试**，验证 = 构建 + 人工清单 + 图像模型复核 |
| `kirara_summary` | 汇总变更 / 构建结论 / 验证状态 / 遗留风险 | 一次收尾，而不是散落一堆工具输出（**零变更轮次不必调**） |

### 典型调用顺序

```
kirara_start({ request: '优化 kirara_docs 的关键词检索排序' })   // 一句话启动
  → mode=small, blocked=false, targets=[desktop]                // 无界面改动 ⇒ 可免实机验证
  → 按 steps 改代码
kirara_build({ project: 'desktop' })                          // 构建验证
kirara_summary({ ... })                                       // 收尾
```

`kirara_start` 的 `mode=auto` 有个**故意的保守设计**：它先按 `full` 探一遍，
只要出现**阻塞项**（破坏性改动 / 数据库结构变更）**或请求涉及用户可见效果**，
就**不允许**降级成 small 草率放过 —— 因为「一句话小功能免实机验证」的前提是这功能真的小，
而且**构建通过 ≠ 效果正确**。实测：

```
[a] 无界面小功能 auto -> mode = small | blocked = false   ← 「优化 kirara_docs 的关键词检索排序」
[b] 破坏性 auto      -> mode = full  | blocked = true    ← 「删除旧的评论表并重构为分表存储」
[c] 空请求           -> blocked = true                   ← 追问而不是瞎路由
[e] 界面改动 auto    -> mode = full  | blocked = false   ← 「给设置页加个暗色开关」
                                                            构建通过不代表暗色主题真的对（与标题栏/Mica 的交互要眼看）
[f] 「迁移」借词      -> blocked = false                 ← 「把设置页的登录迁移到新 API」不是库结构变更
[g] 真·库结构变更     -> blocked = true                  ← 「给用户表加一个 deviceToken 字段，需要改表结构」
```

路由规则（`lib/index.js` 的 `ROUTE_SIGNALS` / `UI_HINTS` / `INTERACTION_SIGNALS` / `DESTRUCTIVE_SIGNALS` / `DB_ACTION ∧ DB_OBJECT`）刻意保持**可解释**：
`reasons` 会随结果一起返回，说明每一条判定命中了哪个信号 —— 判错了能直接看出是哪个正则的问题，
而不是面对一个黑盒结论。详见 `docs/DSH-插件开发流程设计.md` §5.5。

界面/交互判定由**两类**信号共同构成，任一命中即升级 `full`：

| 常量 | 覆盖 | 举例 |
| --- | --- | --- |
| `UI_HINTS` | 外观/视觉词 | 界面、渲染、布局、暗色、图标、动画、xaml |
| `INTERACTION_SIGNALS` | 社交/交互功能词族 | 评论、回复、`@`、提及、提醒、通知、点赞、消息、聊天 |
| `ROUTE_SIGNALS[].ui` | 某端专属的交互词 | `desktop.ui` = 评论/首页/界面/xaml/托盘/任务栏 |

> **为什么要有 `INTERACTION_SIGNALS`**（2026-10-05 实测暴露的假阴性）：DSH 里发
> 「评论支持 @ 提醒」时，请求里**没有任何一个外观词**，于是被判成 `small`（构建成功即完成）。
> 可 @ 提醒的正文就是评论框里的 `@` 选择器，构建通过显然不等于提醒链路正确。
> 教训是**假阴性的代价不对称** —— 把可见功能误判成 `small` 会让人漏掉实机验收直接发出去，
> 误判成 `full` 只是多走一遍清单。所以这类词表刻意宁滥勿缺。

### 已内置的「实测坑」（这些是 `kirara_profile` / `kirara_build` 存在的核心理由）

- **API 端不能构建 `.slnx`**：`Kirara_Server-API.slnx` 第 3 行引用了不存在的 `test-assets/DbCheck/DbCheck.csproj`，
  整解构建会以 `MSB3202` 在 0.8 秒内失败。插件改为构建 `Kirara_Server-API.Server/…csproj`（会带出 Core/Infrastructure/Shared）。
- **桌面端必须显式给平台**：`Kirara_Server-WinUI.slnx` 只注册了 `x64`，必须 `-p:Platform=x64`。
- **Android 端不跑单元测试**：按用户全局约定，只用 `gradlew.bat assembleDebug`。
- **进程清理安全**：内置红线提醒 —— 禁止按名批量杀 `dotnet.exe`、禁止 `dotnet build-server shutdown`（会打断 VS Code 的 C# Dev Kit），只停自己启动的进程；Gradle 用 `gradlew --stop`。

---

## 2. 安装（挂载到 desktop profile）

插件以 **profile bundle** 形式挂载。DSH 的组合顺序是：
`package.json` 的 `dsh.profile.bundles`（按序）→ 用户 `cordis.patch.yml` → `--patch` 覆盖层。

### 2.1 让 profile 依赖本插件

编辑 `$DSH_HOME/profiles/desktop/package.json`：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@kirara/dsh-plugin-kirara-dev": "file:D:/works/Kirara Server Project/dsh-plugin-kirara-dev"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@kirara/dsh-plugin-kirara-dev"
      ]
    }
  }
}
```

> `file:` 会被 pnpm **拷贝**进 `profiles/desktop/node_modules/@kirara/…`。改完源码后必须重新部署
> （`node scripts/deploy.mjs`），否则 DSH 跑的仍是旧副本 —— 这个坑真实发生过，见 §4.1。
>
> 想避免拷贝，可把规格改成 `link:D:/works/Kirara Server Project/dsh-plugin-kirara-dev`：
> pnpm 会建符号链接，`app-boot` 的 `linkedProfileRoots()` 专门识别这种形态（`link:` 不复制、永远指向源码）。
> 代价是每次启动都从源码目录加载，且本机未做过实测验证；换之前先跑 `node scripts/mount-check.mjs`。

上面这段 JSON 也可以交给脚本幂等完成（依赖条目得先手加）：

```powershell
node scripts/deploy.mjs --enable    # 追加到 bundles 末尾
node scripts/deploy.mjs --disable   # 临时摘除（隔离插件排查时不必手改 JSON）
```

### 2.2 声明宿主依赖（**不要安装它们**）

插件用到 `@deepseek-ai/dsh-tools`（提供 `defineTool`）与 `@deepseek-ai/schemastery`（配置校验），
它们在 `package.json` 里声明为 **peerDependencies**，**由宿主提供**：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-tools": "^0.2.0-rc.2",
  "@deepseek-ai/schemastery": "~3.18.4"
}
```

> ⚠️ **绝对不要把这两个包声明成 `dependencies`，也不要在插件目录里 `npm install` 它们。**
>
> 一旦它们在 profile 的 `node_modules` 里出现物理副本，`app-boot` 的 `routeScoped()` 会判定
> `kind: 'native'`（**本地物理副本优先于拦截**），宿主于是加载第二份 `dsh-tools`。
> `TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler')` 是模块实例私有的，
> 两份副本 = 两个 Symbol ⇒ `ctx.tools[SYMBOL]` 为 `undefined` ⇒ `dsh-agent-loop` 每次派发
> （**包括内置 `read` / `pwsh`**）都崩在 `Cannot read properties of undefined (reading 'prepare')`。
> 完整事故档案见 §4.1。
>
> 这正是本插件 2026-10 那次「启用插件后所有工具调用全崩」的根因；DSH 自己的包也是同款做法 ——
> `dsh-tools` 把 11 个 `@deepseek-ai/dsh-*` 兄弟包全部声明为 `peerDependencies`，只留 3 个真实 `dependencies`。
>
> 开发期确实需要在插件目录里放一份宿主包（离线跑自检用），所以它们在 `package.json` 里
> 声明为 **`devDependencies`**（带确切版本）。`devDependencies` 永远不会被包管理器装进依赖方，
> 因此这条路**不会**污染 profile：
>
> ```json
> "devDependencies": {
>   "@deepseek-ai/cordis": "4.0.4",
>   "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
>   "@deepseek-ai/schemastery": "3.18.4"
> }
> ```
>
> 三者的角色不同：`dependencies` 会污染 profile（事故原因），`peerDependencies` 声明运行期由宿主提供，
> `devDependencies` 只服务本仓库的自检脚本。`deploy.mjs --check` 的第 4/5 项分别守前两条线。

### 2.3 物化 profile 依赖树（重新部署）

`profiles/desktop` 是 pnpm workspace（`nodeLinker: hoisted`），需要让 pnpm 把 bundle 铺到
`profiles/desktop/node_modules`。DSH 自带 pnpm，直接用 Node 跑它即可（不用起 Electron）：

```powershell
node "C:\Users\90693\AppData\Local\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.cjs" `
  install --dir "$env:USERPROFILE\.dsh\profiles\desktop" --no-frozen-lockfile
```

更省事的做法是直接跑仓库里的部署脚本，它会**先清空 `node_modules`、再重装、然后校验不变量**
（`file:` 安装是拷贝，pnpm 不会主动重建被改动过的副本 —— 实测「Already up to date」会骗过你）：

```powershell
node scripts/deploy.mjs           # 重新部署 + 校验
node scripts/deploy.mjs --check   # 只校验，不写入
```

pnpm 会报 `Issues with peer dependencies found` —— 这是**预期**的，宿主包不该被装进 profile。

### 2.4 可选：调整配置

插件的 `cordis.patch.yml` 已带默认配置。要覆盖，在 `$DSH_HOME/profiles/desktop/cordis.patch.yml`
按 **id** 定位该行（后续写入获胜）：

```yaml
- insert:
    - id: kirara-dev
      name: '@kirara/dsh-plugin-kirara-dev'
      config:
        workspaceRoot: 'D:\works\Kirara Server Project'
        buildTimeoutMs: 1200000
        buildLogTailLines: 60
```

配置项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `workspaceRoot` | `''` | 三端仓库父目录。留空时依次回退到 `DSH_WORKSPACE`、`process.cwd()` |
| `buildTimeoutMs` | `1200000` | 单次构建最长等待（20 分钟，够 Gradle 冷启动） |
| `buildLogTailLines` | `60` | 回传的日志尾部行数（防止撑爆模型上下文） |

### 2.5 生效

改 `package.json` 的 bundles 需要**重启 DSH**。重启后模型即可看到 `kirara_*` 工具。

重启前的完整顺序：

```powershell
cd "D:\works\Kirara Server Project\dsh-plugin-kirara-dev"
node scripts\deploy.mjs --enable   # 1) 挂进 bundles（已挂则无操作）
node scripts\deploy.mjs            # 2) 重新部署最新源码 + 校验 8 项不变量
node scripts\mount-check.mjs       # 3) 挂载路径检查（内部串 contract-test）
# 4) 完全退出 DSH 再重新启动 —— 然后在**新会话**里用 §3.4 的 listTools 验收
```

> **必须开新会话**：旧会话的历史消息里已经录下了修复前的失败工具调用（以及那份
> 残缺的工具名快照），旧记录无法修复，只会在新会话里干净地重建。

---

## 3. 开发期自检（不用重启 DSH）

DSH 的 desktop profile 由 Electron 独占，`dsh --profile desktop` 会被拒绝，所以迭代时用 `scripts/` 下的四个夹具。
它们把反馈环从「重启 DSH」缩到秒级，**分层覆盖**不同的失败面：

| 脚本 | 覆盖的失败面 | 是否走宿主真实代码 |
| --- | --- | --- |
| `selftest.mjs` | 工具**业务逻辑**：注册 + 逐个执行（含一次真实 `dotnet build`） | ✗ 假 `ctx.tools` |
| `deploy.mjs` | **部署形态**：profile 副本 == 源码、profile 里无宿主包副本 | ✗ 只做文件/清单断言 |
| `mount-check.mjs` | **解析归层**：复现 `routeScoped` 的两锚点判定 + 清单形态 | ✗ 模拟判定 |
| `contract-test.mjs` | **真实调度链路**：真 `cordis.Context` + 真 `ToolRuntime`，逐个 `prepare()` | ✓ 全真 |

```powershell
cd "D:\works\Kirara Server Project\dsh-plugin-kirara-dev"
node scripts\deploy.mjs          # 部署最新源码到 profile + 校验不变量
node scripts\selftest.mjs        # 工具级自检
node scripts\mount-check.mjs     # 挂载路径检查（内部会串 contract-test.mjs）
node scripts\contract-test.mjs   # 只跑真实契约测试
```

### 3.1 `contract-test.mjs`：为什么这个才是关键

`selftest.mjs` 用假 `ctx.tools.register`，**从不经过宿主的 `ToolRuntime`** —— 这正是事故期间
「自测全绿、真机全崩」的盲区。`contract-test.mjs` 补上这一环：

```text
=== 2. 真实 cordis Context + ToolRuntime ===
  ✓ ToolRuntime 已作为 ctx.tools 服务挂载
  ✓ TOOL_RUNTIME_SCHEDULER 可解析且带 prepare()      ← 事故里就是这里为 undefined
=== 3. 加载插件并 apply() ===
  ✓ apply(ctx, config) 未抛异常
  ✓ 真实 ToolRuntime 里找到全部 7 个 kirara_* 定义
=== 4. 真实调度器 prepare()（每个工具） ===
  ✓ kirara_start: prepare → dispatch      arguments = {"request":"…"}
  ✓ kirara_profile: prepare → dispatch    arguments = {}
  ✓ kirara_docs: prepare → dispatch       arguments = {"keywords":[]}
  ✓ kirara_route: prepare → dispatch      …
  ✓ kirara_build / kirara_verify / kirara_summary: prepare → dispatch
=== 5. presentCall() 视图形状 ===
  ✓ kirara_start: 视图合法   {"card":"generic","title":"🚀 一句话启动开发","kind":"other","rawInput":"…"}
  ✓ … 七个全部 card=generic / title 非空 / kind ∈ ToolCallKind
=== 6. 完整链路 prepare → dispatch → finish（kirara_profile） ===
  ✓ 工具体执行成功（isError 非 true）
      Kirara profile @ D:\works\Kirara Server Project
      - [desktop] Kirara_Server WinUI 3 桌面客户端
          build: dotnet build Kirara_Server-WinUI.slnx -c Debug -p:Platform=x64 --nologo
      - [api] Kirara_Server-API 后端服务
          build: dotnet build Kirara_Server-API.Server/Kirara_Server-API.Server.csproj -c Debug --nologo
      - [media] Kirara_Media Android 客户端
          build: gradlew.bat assembleDebug --console=plain
=== 6.5 工具返回值 lossless JSON 边界（7 个工具真派发） ===
  ✓ kirara_start / kirara_profile / kirara_docs / kirara_route / kirara_verify / kirara_summary: 返回值可被宿主接受
  ✓ kirara_build 构建成功但无 APK: 返回值为 lossless JSON    exit=0、无产物 ⇒ artifact 必须省略而不是 undefined
  ✓ kirara_build 构建失败且无 APK: 返回值为 lossless JSON    exit=3
  ✓ kirara_verify full 无截图（screenshotReview 必须整体省略）: 通过    协议段 已省略，正文无 undefined
  ✓ kirara_verify full 带截图（screenshotReview 应出现）: 通过          协议段 已出现，正文无 undefined
  ✓ kirara_start @ 提及类请求: 未降级为 small       mode=full（自动判定：请求涉及用户可见效果…）
  ✓ kirara_start 评论交互类请求: 未降级为 small     mode=full（自动判定：请求涉及用户可见效果…）
  ✓ lib/index.js 没有「显式赋 undefined」的返回字段
=== 6.6 端到端真构建 kirara_build api（可选，加 --live-build） ===
  ✓ 真实 api 构建经宿主返回      ✅ 构建成功 — api  (1.4s, exit=0)
=== 7. 模块身份唯一性 ===
  ✓ profile 里没有 dsh-tools 副本        ✓ profile 的 @deepseek-ai/ 为空
```

它通过 `scripts/host-interception.mjs`（Node 的 `module.register` 解析钩子）复现了宿主的拦截语义：
宿主作用域内的包名一律指向宿主那一份，本地候选不参与 —— 这正是 `routeScoped` 在
「无物理候选」时的行为。**被测入口默认是 profile 里已部署的副本**，不是源码树。

§6.5 用**临时 workspaceRoot + 假 `gradlew.bat`** 把 `kirara_build` 真派发一遍（毫秒级、不碰任何
真实工具链），因为「构建完成但没有产物」正是 media 的真实失败面，也是 §4.2 那个 bug 的入口。
它同时把其他 6 个工具也真派发一次 —— 返回值边界是全工具的共性约束，不该只测一个。

### 3.2 `selftest.mjs` 输出样例

```text
=== 0. kirara_start（一句话启动，两种走向都要对） ===
[a] 小功能 auto      -> mode = small | blocked = false
[b] 破坏性 auto     -> mode = full | blocked = true
[c] 空请求          -> blocked = true | decisions = 1
[d] docsToRead 条数 = 1 | 每端最多 4 篇 = true
…
ok = true  exit = 0  duration = 2.3s
=== 全部工具执行完毕，插件自检通过 ===
```

---

## 3.3 实机验证的视觉复核（`ecnu-plus`）

项目的验证约定是「构建 + 人工清单」，人工清单由 `kirara_verify` 产出。
当人已经截好图，可以把路径一并传进去，让**图像模型代替人先过一遍**：

```jsonc
kirara_verify({
  summary: '设置页加暗色开关',
  project: 'media',
  mode: 'full',
  screenshots: ['D:/shots/settings-dark.png', 'D:/shots/settings-light.png'],
})
```

返回里会多出 `screenshotReview`，包含：

| 字段 | 含义 |
| --- | --- |
| `provider` / `model` | 固定为 `chatecnu` / `ecnu-plus` |
| `screenshots[].path` | 归一化后的绝对路径 |
| `screenshots[].exists` | **插件真的去 stat 了**；缺文件会标 `⚠️ 文件不存在`，不会静默跳过 |
| `instruction` | 一段可直接执行的复核提示词（渲染在工具输出里） |

**为什么插件不自己调模型**：插件跑在 DSH 宿主进程，只拿到 `ctx.tools`，拿不到会话级 `llm` 服务。
所以它只产出「怎么调」的协议，真正的多模态请求由模型按协议发起（把每张图作为
`ImageBlock` attachment 发给 `ecnu-plus`）。这样插件保持无副作用、可离线自检。

**模型选择依据**：profile 的 `llm-pi-ai` 配置里，`ecnu-plus` 是唯一声明
`input: [text, image]` 的模型；`ecnu-max` 仅文本；`ecnu-image-pro` 已下线（调用返回 500）。

复核提示词固定四问：① 是否正常渲染（无白屏/错位/乱码/占位图）；② 是否可见本次改动对应的 UI；
③ 有无明显异常（错误弹窗、缺失图标、对比度问题）；④ 逐条「通过 / 不通过 + 依据」。
明确要求「不要臆测看不到的内容」，避免模型对着截图编。

---

## 3.4 判断「插件到底加载了没」—— 用**会话内可见的证据**

> ⚠️ **2026-10-05 实测更正：不要押在 Inspect 上。**
> 那天线上两个真实会话的 Agent 工具表里**根本没有** `cordis_inspect_*`，
> `cordis_inspect_query(...)` 无从调用（§4.1 结尾有补充）。
> **验收必须建立在会话自己能观察到的东西上**：
>
> 1. 工具表里有 7 个 `kirara_*`（`kirara_start / kirara_profile / kirara_docs / kirara_route /
>    kirara_build / kirara_verify / kirara_summary`）；
> 2. **真调一次看返回值**：`kirara_profile({ project: 'desktop' })` 应给出正确的 `workspaceRoot` 与 `buildLine`，
>    `kirara_docs({ keywords: ['Kirara'] })` 应命中真实文档路径；
> 3. **同一会话里内置 `read` / `pwsh` 正常** —— §4.1 事故里它们和 `kirara_*` 一起崩。
>
> 工具**总数不是判据**：线上会话实测 **41 = 30 基础 + 7 kirara + 4 goal/agent 类**（随会话形态浮动）。
> 只要 `kirara_*` 七个齐全即为通过；数字波动不代表插件没加载。
>
> 若哪天 Inspect 可用，它可以做双保险 —— 它返回 host `Tool` 注册表的权威列表
> （"Return every Tool schema currently callable by this Agent"）：

```jsonc
cordis_inspect_query({ platform: 'host', provider: 'Tool', method: 'listTools' })
```

**夹具**里测到的样子（`contract-test.mjs` 指向的宿主注册表，重启前）：

```text
工具数 = 34
read, write, edit, glob, grep, pwsh, job_output, job_list, job_kill, skill,
web_search, web_fetch, present, cordis_inspect_list, cordis_inspect_query,
plugin_manager, read_image, send_message, interrupt_agent, list_agents,
todo_write, workflow, get_goal, create_goal, update_goal, ask_user_question,
exit_plan_mode, subagent_fork, subagent, load_workspace_dependencies, …
→ 无任何 kirara*
```

价值在于**能区分两种失败**：

| `listTools` 结果 | 含义 | 该查什么 |
| --- | --- | --- |
| 有 `cordis_inspect_*`、无 `kirara_*` | 运行时正常，**插件没被加载** | bundle 声明 / profile 依赖 / 补丁文件路径 |
| 连 `cordis_inspect_*` 都异常 | 会话或 Inspect 本身有问题 | 与插件无关，先修会话 |

比看进程启动时间靠谱 —— 它是运行时的自我报告，不是外部推断。

**两套计数口径都对，别互相卡**：夹具的宿主注册表基线是 **30** → 装后 **37**（+7 个 `kirara_*`）；
线上**会话**口径实测是 **41**（= 30 + 7 + 4 个 goal/agent 类，随会话形态浮动）。
**以 `kirara_*` 七个是否齐全为准** —— 这正是 §4.1 的教训：**不要相信记录里的数字，要看现场**。

### 3.4.1 重启后的验收入口（修复后必查）

1. 工具表里 `kirara_start / kirara_profile / kirara_docs / kirara_route / kirara_build / kirara_verify /
   kirara_summary` 七个全部出现（**不必数总数**，理由见 §3.4）；
2. **在同一会话里调一次内置 `read` 或 `pwsh`** —— §4.1 事故里它们也和 `kirara_*` 一起崩；
   若 `pwsh` 只报 `Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<目录>)`，
   那是**沙箱 ACL 前置条件**问题、与插件无关，见 §4.3；
3. `kirara_profile({})` 应返回 `workspaceRoot = D:\works\Kirara Server Project`、
   `projects = desktop, api, media`、`missing = []`，且 `buildLines` 为：
   - desktop → `dotnet build Kirara_Server-WinUI.slnx -c Debug -p:Platform=x64 --nologo`
   - api → `dotnet build Kirara_Server-API.Server/Kirara_Server-API.Server.csproj -c Debug --nologo`
   - media → `gradlew.bat assembleDebug --console=plain`

> 还崩 `prepare`？跑到插件目录执行 `node scripts\deploy.mjs --check` —— 它会直接指出
> profile 里残留的宿主包副本（那就是根因，见 §4.1）。

---

## 4. 作者契约（逆向自 DSH 自带插件，已在 `0.2.0-rc.2` 实测）

插件是 **ESM 模块**，必须具名导出：

```js
export const name = 'kirara-dev';        // 插件名
export const inject = ['tools'];          // 依赖的 DSH 服务
export const Config = z.object({...});    // @deepseek-ai/schemastery
export function apply(ctx, config) {      // 注册入口
  ctx.tools.register(defineTool({ ... }));
}
```

`defineTool` 的形状（来自 `@deepseek-ai/dsh-tools`）：

```js
defineTool({
  name: 'tool_name',
  description: '给模型看的说明',
  parameters: {                       // ParameterSchemaSpec，不是标准 JSON Schema
    foo: { type: 'string', required: true, description: '…' },
    bar: { type: 'string', enum: ['a','b'] },   // 可选：省略 required
  },
  output: {
    schema: { /* ValueSchemaSpec，同上 */ },
    render: (args, value) => [{ type: 'text', text: '…' }],
  },
  execute(args, exec) { /* 返回 value 或 Promise */ },
  presentCall: (args) => ({ card: 'generic', title: '…', kind: 'other' }),
});
```

### ⚠️ 三个实测踩到的硬性校验（会直接抛 `JsonSchemaError`，插件整段加载失败）

1. **`required` 为真时，该键必须出现在同级 `properties` 里。**
   ```js
   { type:'object', properties:{ a:{...} }, required:true }   // ✗ properties.required must be true when present
   { type:'object', properties:{ a:{...} }, required:{...} }  // ✓
   ```
   错误原文：`unsupported JSON schema: schema.properties.X.required must be true when present`。

2. **可选字段写 `required: false` 也会报错**（编译器要求 present 时必为 `true`）。
   正确写法是**整个省略** `required`。

3. **`apply()` 里抛异常会静默终止加载**（在某些宿主下进程 `exit 0` 且无堆栈）。
   调试时务必自己在 `apply` 外层套 `try/catch` 打印 `err.message`。

### Bundle 契约

插件包要作为 bundle 被 DSH 识别，`package.json` 必须声明：

```json
{
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 顶层是**数组**，元素形如 `- insert: [ <entry> ]`，
entry 的 `name` 是 ESM 模块说明符，`config` 会**整行替换**（不是深合并）。

### 加载器契约（摘自 `@deepseek-ai/dsh-app-boot` 的 `profile.js` 文档注释）

上面这些做法不是猜的，DSH 自己的源码把机制写死了：

> Profile discovery … A profile is a directory under `$DSH_HOME/profiles/<name>` holding
> a `package.json` (out-of-tree plugin dependencies plus the profile manifest `dsh.profile`
> with its ordered `bundles` list) and a `cordis.patch.yml` (the user's own patch layer,
> applied after every bundle layer). Bundles are npm packages whose manifest declares
> `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` …; the tree is composed by
> applying each bundle's patch lists in `dsh.profile.bundles` order over an empty entry list,
> then the profile's own patches, then any launcher layers (`--patch` files and
> flag-derived patches).
>
> Module resolution is **two-anchor** by construction: a bundle name resolves first from the
> dsh installation (the launcher's own package), then from the profile directory.
> Pnpm-managed entries in the profile's `node_modules` resolve first.

对应到本项目：

| 契约 | 本插件的落实 |
| --- | --- |
| Bundle = 声明 `dsh.bundle.patch` 的 npm 包 | `package.json` 里 `dsh.bundle.patch = "./cordis.patch.yml"` |
| 按 `bundles` 顺序叠加在空 entry 列表上 | `@deepseek-ai/dsh-base` → `dsh-web-app` → `@kirara/dsh-plugin-kirara-dev` |
| 解析锚点：dsh 安装 → profile 目录 | 插件本体从 profile 的 `node_modules` 命中；**宿主包（`@deepseek-ai/*`）必须走「无本地候选 → interception」那条路**，由安装锚点提供 |
| 补丁路径 = `join(packageDir, patch)` | 实际读取 `<repo>/dsh-plugin-kirara-dev/cordis.patch.yml`（`file:` 拷贝到 profile 后同样读到这份副本） |

所以**改完 `cordis.patch.yml` 或 `package.json` 必须重启 DSH**（这两个只在启动时读一次）；
只改 `lib/index.js` 才有机会被 HMR 热加载 —— 但 `file:` 安装是拷贝，改完源码要**重新部署**（`node scripts/deploy.mjs`）才会传染到 profile。

### 4.1 事故档案：`Cannot read properties of undefined (reading 'prepare')`

**现象**：启用插件后，某个会话里**所有**工具调用全部崩掉 —— 包括内置的 `read` 和 `pwsh`，
模型因此反复重试并烧光上下文，整个开发流程中断。

**错误假设**（已被证伪）：旧会话历史固化了 41 个工具名（含 `kirara_*`），与当前 34 工具的注册表不一致。
实测：崩溃会话的注册表只有 27 个内置工具、**根本没有 `kirara_*`**，照样崩；改会话历史也没用。

> 2026-10-05 补充：线上会话后来实测**就是 41 个**（30 + 7 kirara + 4 goal/agent，见 §3.4）——
> 「41」不是凭空来的，但当时拿它当硬标准仍错在**口径**（夹具 30 / 线上 41 是两套计数）。
> 另外当天还实测到一个反向教训：**`cordis_inspect_*` 本身也可能不在工具表里** ——
> 判「插件加载了没」只能靠 `kirara_*` 是否可调，不能靠 Inspect。

**真实根因**（已用源码 + 实测双重证实）：

```
插件 package.json 把 @deepseek-ai/dsh-tools / schemastery 声明成 dependencies
        ↓  pnpm install（nodeLinker: hoisted）
profiles/desktop/node_modules/@deepseek-ai/ 出现 6 个物理副本（dsh-tools / schemastery /
        dsh-brand / dsh-util-values / cosmokit / @standard-schema-spec）
        ↓  app-boot routeScoped()：物理候选存在 ⇒ kind:'native'（本地赢过拦截）
宿主加载了**第二份** dsh-tools（tools 服务来自 profile 副本）
        而 dsh-agent-loop 用的是安装目录那一份
        ↓  TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler') 是模块私有
两个 Symbol ≠ 同一个 ⇒ registry[SYMBOL] === undefined
        ↓  dsh-agent-loop/lib/index.js:582
ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)  ⇒  undefined.prepare(...)  💥
```

关键是它**与插件是否在 bundles 里无关** —— 只要那几份物理副本还留在 profile，就会持续崩。

**修复**（已实施并验证）：

1. `package.json`：`dependencies` → **`peerDependencies`**（与 DSH 自己的包同款做法）；
2. 清空 profile 的 `node_modules` 重装：`Packages: -6`，`@deepseek-ai/` 与 `@standard-schema/` 直接消失；
   `pnpm-lock.yaml` 从 3332B 缩到 800B，两个宿主包从 `dependencies` 段移到 kirara 条目的 `peerDependencies:` 段；
3. 硬性不变量（`deploy.mjs` 断言）：**profile 副本的 Node 解析路径里不得存在任何宿主包候选**；
   另加一条：lockfile 也不得把宿主包记成运行期依赖（旧锁文件会把后来者引回老路）。

> 教训：插件对宿主包声明 `dependencies` 会通过包管理器的提升机制**静默污染宿主 profile**；
> `routeScoped` 里「物理副本优先于拦截」使这个污染不可逆地分裂模块身份；
> 而模块身份分裂的**唯一表征**是一个 `undefined` 的属性读取。
> 假 `ctx` 的自测永远看不到这一层 —— 所以后来补了 `contract-test.mjs`。

### 4.2 事故档案二：`tool "kirara_build" returned invalid output`

**现象**：`kirara_build project=api` 在 DSH 里 **100% 失败**，返回

```text
Error: tool "kirara_build" returned invalid output: value is not lossless JSON
```

文案带 `tool "…"` 前缀、看着像 harness 自己的毛病；实际是**插件返回值违规**。
当时 API 构建本身是成功的（`已成功生成。0 个警告 0 个错误，已用时间 00:00:01.27`），
所以现场表现是「构建明明过了，工具却报错」。

**影响面**：`PROJECTS` 里只有 media 声明了 `apk`，而 `artifact` 仅在 APK 真实存在时才赋值 ——
⇒ api / desktop **这两端的构建验证从来没成功返回过**；media 只在构建产出 APK 后才可用。
另一条触发路径是 `exitCode: r.code ?? undefined`：超时或启动失败时 `code` 为 `null`，
于是连 media 的超时路径也一起坏掉。

**宿主的判定**（实测 `@deepseek-ai/dsh-util-values` 的 `walkJsonValue`）：

| 返回形状 | lossless 快照 | output schema |
| --- | --- | --- |
| 缺键（条件展开省略） | ✅ | ✅ |
| `exitCode: undefined` | ❌ `snapshotJsonValue` 返回 `undefined` | ❌ `"value" must be a lossless JSON object` |
| `exitCode: null` | ✅ | ❌ `"value.exitCode" must be an integer` |
| 嵌套 `undefined` / 数组洞 / `NaN` | ❌ | ❌ |

对象分支是**逐键 visit** 的，值为 `undefined` 的自有可枚举键会落到
`typeof current !== "object"` 那一行直接判负 —— 不存在「JSON.stringify 会顺手丢掉」的侥幸。

**修复**（`lib/index.js` 的 `kirara_build`）：可选键一律**整键省略**，不要赋 `undefined`：

```js
...(r.code == null ? {} : { exitCode: r.code }),
...(artifact === undefined ? {} : { artifact }),
```

> 注意**不能**用 `?? null` 兜 —— `exitCode` 在 schema 里声明为 `integer`，`null` 会被
> `must be an integer` 拒掉。同文件其他三处的 `apk: p.apk ?? null` 之所以合法，
> 是因为那些键的 schema 允许 `null`。

**为什么自测没抓到**（两个盲点同时生效）：

1. `selftest.mjs` §7 直调 `execute()`，**绕过宿主的快照与 schema 校验** ⇒ 本地 `exit=0`，宿主必拒；
2. `contract-test.mjs` §6 只对 `kirara_profile` 做了完整 `dispatch`，而它的返回值恰好干净 ——
   夹具只检查 `prepare()` 的形状，**从不检查返回值**。

**新守卫**：`contract-test.mjs` §6.5（7 个工具真实派发 + `kirara_build` 两种退出码 + 源码里
不得出现「显式赋 `undefined`」的字段）与 §6.6（`--live-build` 真跑 api 增量构建）。

### 4.2.1 事故档案二·续：同一个坑换了个工具 —— `kirara_verify`

§4.2 修完 `kirara_build` 后，`kirara_verify` 的收尾仍然是旧写法：

```js
return Promise.resolve({ skipped: false, steps, howToInstall, screenshotReview });
//                                                                 ^^^^^^^^^^^^^^^^
//                            无 screenshots 时恒为 undefined ⇒ 整个调用被宿主拒收
```

**现象**：DSH 实测 `kirara_verify` **每次都**返回
`tool "kirara_verify" returned invalid output: value is not lossless JSON` ——
`mode=full` 且没传 `screenshots` 就必现（`mode=small` 走提前 return，反而侥幸正常）。

**为什么 §4.2 的新守卫没拦住**（两条守卫同时有缝）：

1. `contract-test.mjs` §6.5(a) **确实**派发了 `kirara_verify`，但 `sampleFor` 给 `mode`
   造的样本是 `'auto'`；而「是否生成截图协议」只取决于 `screenshots` —— 参数组合恰好绕开了
   出错的那条分支。**「派发过了」不等于「覆盖到了」**。
2. §6.5(c) 的静态审计正则是 `/^\s*(\w+):[^,\n]*?\bundefined\b\s*,?\s*$/`，
   要求 `undefined` 之后必须是逗号或行尾。事故那行是 `screenshotReview });` ——
   `undefined` 后面直接跟 `}`，**整条被正则漏掉**，于是 4 个 `✓` 全绿而 bug 健在。

**修复**（`lib/index.js` 的 `kirara_verify`）：与 §4.2 同一手法，可选键条件展开：

```js
return Promise.resolve({
  skipped: false,
  steps,
  howToInstall,
  ...(screenshotReview ? { screenshotReview } : {}),
});
```

**加固后的守卫**：

- 运行时显式补两种入参（无截图 / 带截图），并断言**协议段出现时机与 `screenshots` 一致**、
  正文不得出现 `undefined` 字样 —— 直接盯住出错的那条分支，不再依赖 `sampleFor` 的运气；
- 静态审计正则放宽为
  `/^\s*([A-Za-z_$][\w$]*):[^\n]*?(?<![=!?.\w])\bundefined\b\s*(?:,|$|[})])/gm`，
  补上「裸标识符后跟 `}` / `)`」这一形态（`undefined` 前的负向回顾避免把
  `x === undefined` / `a?.undefined` 误判）。

> **可复用的教训**：`undefined` 泄漏是**逐个工具**发生的，不会因为同类问题修过一次就免疫。
> 新增任何带可选字段的工具返回值，都要问一句「这个键在什么入参下会是 `undefined`」，
> 并让契约测试**显式覆盖那个入参**。

---

### 4.3 事故档案三：会话里 `pwsh` 全崩于 `SetNamedSecurityInfoW failed (Win32 5)`

**现象**（2026-10-05，工作区在 **D:** 盘）：会话里**所有** `pwsh` 调用失败 —— 哪怕只有 `Get-Location`：

```text
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\works\Kirara Server Project)
```

而 `kirara_*` 七个工具**完全正常**（同会话实证：`kirara_build` 调用 91 次、70 次返回「构建成功」）——
`kirara_*` 走自己的子进程、**不经过沙箱**，所以那段时间它反而是唯一还能干活的工具。
同一台机器上，工作区在 **C:** 用户目录的会话**从不**报这个错。

**根因**（DSH 自带 `dsh-sandbox-windows-acl` 的 README 原文，已由封闭实验证实）：

> Granted directories must be caller-owned and grant `WRITE_OWNER` — the owner's implicit rights
> cover only `READ_CONTROL` and `WRITE_DAC`; the label lives in the SACL, so the combined apply
> additionally needs `WRITE_OWNER` (a Full-control directory, the normal workspace case, has it).
> **A directory whose DACL grants only Modify now fails the grant loudly.**

D: 卷根目录的**默认继承 ACL 只给子目录 `Authenticated Users:(M)`（Modify）**，没有 `WRITE_OWNER`；
`C:\Users\<你>` 树默认带当前用户 `(F)`。沙箱要在工作区根上写**完整性标签（SACL，需 `WRITE_OWNER`）**，于是必崩。

**封闭实验**（非提权、同一 ACL 形状的空目录）：

| 操作 | 结果 |
| --- | --- |
| `icacls <dir> /setintegritylevel L` 写标签 | ❌ `Access is denied.`（exit=5） |
| 先 `icacls <dir> /grant "*<当前用户SID>:F"` 再写标签 | ✅ exit=0 |

⇒ **工作区所在的 NTFS 目录树只要缺一条「当前用户完全控制」ACE 就必崩**，与插件、与 DSH 版本无关。

**修复**（DSH 官方技能 `diagnose-windows-sandbox-acl`：诊断+修复一条命令，**不要提权、不要 UAC**）：

```powershell
# 脚本本体在 app.asar 里（会话内 DSH 会把它解出来给同名技能用）；先提取：
node D:\works\_dsh_probe\asar.mjs "<DSH>\resources\app.asar" extract "diagnose-windows-sandbox-acl" <outDir>
# 对**失败路径（= 工作区根）**执行；-AllowRoot 与 -Path 相同即可「自我修复」：
& '<out>\dsh\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\assets\diagnose-windows-sandbox-acl\scripts\diagnose-windows-sandbox-acl.ps1' `
  -Path 'D:\works\Kirara Server Project' -AllowRoot 'D:\works\Kirara Server Project' -Out '<recoveryDir>'
exit $LASTEXITCODE     # 0 = 成功
```

输出判读：`VERDICT=PRECONDITION`（`writeDac:true, writeOwner:false`）→ `grant_dacl` →
`verification: verified`（`after:{writeOwner:true}`）→ `SUMMARY FIXED=0 GRANTED=1`。
每个改动前先备份 DACL 并打印独立回滚命令（`-Restore <备份.json>`）；
`nextAction=verify_original_confined_operation` 的意思就是 **回 DSH 会话原样重试**。

**本机修复结果**：`D:\works` 与 `D:\works\Kirara Server Project` 各加了一条当前用户 `(F)`：

```text
D:\works\Kirara Server Project AKENO-TX\90693:(F)      ← 新增（非继承，原继承项原样保留）
```

**无需重启 DSH**（授权失败不会被缓存，下次调用重新物化即成功）；
每个「非系统卷上的工作区根」各修一次，**父目录也要**（若某个会话的工作区根就是 `D:\works` 本身）。

> 顺带排除一个假嫌疑：本机没装 PowerShell 7，但 `pwsh` 工具**会自动回落**到 Windows PowerShell 5.1 ——
> `dsh-pwsh-local` 的解析顺序是 `%ProgramFiles%\PowerShell\7\pwsh.exe` → `PATH` 里的 `pwsh.exe`
> → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` → `pwsh`。
> 所以缺 PowerShell 7 **不是**报这个错的原因。

---

## 5. 目录结构

```
dsh-plugin-kirara-dev/
├── package.json               # bundle 声明（dsh.bundle.patch）+ peerDependencies 契约
├── cordis.patch.yml           # insert 层 + 默认配置
├── lib/index.js               # 全部插件逻辑（ESM，无构建步骤）
├── scripts/
│   ├── deploy.mjs             # 部署到 profile + 校验 8 项不变量（改完源码必跑）
│   ├── contract-test.mjs      # 真 cordis + 真 ToolRuntime，逐个 prepare()
│   ├── host-interception.mjs  # 复现宿主模块拦截语义的解析钩子（供上一行使用）
│   ├── mount-check.mjs        # 复现 routeScoped 两锚点判定 + 串 contract-test
│   └── selftest.mjs           # 假 ctx.tools，跑通全部工具（含一次真实构建）
└── README.md                  # 本文件
```

`lib/index.js` 是**直接可加载的 ESM 源码**，不需要编译 —— DSH 的 loader 直接 `import()` 它。
改完代码后：`node scripts/deploy.mjs`（同步到 profile）→ 重启 DSH（或依赖 profile 的 HMR）。

> 进 profile 的只有 `package.json`、`lib/index.js`、`cordis.patch.yml`，外加 npm 强制包含的
> `README.md`（见 `package.json` 的 `files` 数组）。**`scripts/` 与 `node_modules/` 都不会进 profile** ——
> 所以自检脚本永远在源码树里跑，profile 副本只有一份干净的运行时产物。
>
> `node_modules/` 里那份 `@deepseek-ai/*` 是**开发期**为了离线跑自检而装的（`host-interception.mjs`
> 与 `contract-test.mjs` 要用真包），与部署无关；`deploy.mjs --check` 的第 4 项会确保它永远进不了 profile。

---

## 6. 与「三端项目画像」的同步

`lib/index.js` 顶部的 `PROJECTS` / `SAFETY_RULES` 常量是**项目事实的唯一来源**。
当各端构建方式、TFM、硬约束变化时，改这里即可，无需改工具逻辑。

> 已知待办：`kirara_-server-api/Kirara_Server-API.slnx` 的悬空引用
> （`test-assets/DbCheck/DbCheck.csproj`）。修掉之后可把 API 端构建命令换成整解构建，
> 并同步更新 `PROJECTS.api.build.args` 与 `constraints`。
