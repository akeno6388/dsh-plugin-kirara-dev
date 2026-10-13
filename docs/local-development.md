# 本地开发

面向插件本体的开发。只想装上用的话看 [README](../README.md) 就够了。

DSH 的 desktop profile 由 Electron 独占，`dsh --profile desktop` 会被拒绝，所以迭代时用 `scripts/`
下的自检夹具，把反馈环从「重启 DSH」缩到秒级。

## 挂载到 profile

插件以 **profile bundle** 形式挂载。DSH 的组合顺序是：
`package.json` 的 `dsh.profile.bundles`（按序）→ 用户 `cordis.patch.yml` → `--patch` 覆盖层。

### 1. 让 profile 依赖本插件

编辑 `$DSH_HOME/profiles/desktop/package.json`：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@kirara/dsh-plugin-kirara-dev": "file:<工作区根>/dsh-plugin-kirara-dev"
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

`dependencies` 与 `bundles` 是两件事：前者只负责把文件物化到 `node_modules`，后者才决定
「启动时加载哪些插件」。只写 `dependencies` 不写 `bundles`，插件会静默不生效。

`file:` 会被 pnpm **拷贝**进 `profiles/desktop/node_modules/@kirara/…`，改完源码必须重新部署，
否则 DSH 跑的仍是旧副本。

想避免拷贝，可以把规格改成 `link:<工作区根>/dsh-plugin-kirara-dev`：
pnpm 会建符号链接，`app-boot` 的 `linkedProfileRoots()` 专门识别这种形态（`link:` 不复制，
永远指向源码）。代价是每次启动都从源码目录加载，换之前先跑 `node scripts/mount-check.mjs`。

上面这段 JSON 也可以交给脚本幂等完成（依赖条目得先手加）：

```powershell
node scripts/deploy.mjs --enable    # 追加到 bundles 末尾
node scripts/deploy.mjs --disable   # 临时摘除（隔离插件排查时不必手改 JSON）
```

### 2. 物化 profile 依赖树

`profiles/desktop` 是 pnpm workspace（`nodeLinker: hoisted`），需要让 pnpm 把 bundle 铺到
`profiles/desktop/node_modules`。DSH 自带 pnpm（系统 PATH 上没有），用 Node 跑它即可 —— 把第一段换成本机 DSH 的安装目录：

```powershell
node "<DSH 安装目录>\resources\runtime\pnpm\bin\pnpm.cjs" `
  install --dir "$env:USERPROFILE\.dsh\profiles\desktop" --no-frozen-lockfile
```

更省事的做法是直接跑仓库里的部署脚本，它会先清空 `node_modules`、再重装、然后校验不变量
（`file:` 安装是拷贝，pnpm 不会主动重建被改动过的副本 —— 实测「Already up to date」会骗过你）：

```powershell
node scripts/deploy.mjs           # 重新部署 + 校验
node scripts/deploy.mjs --check   # 只校验，不写入
```

pnpm 会报 `Issues with peer dependencies found` —— 这是**预期**的，宿主包不该被装进 profile。

可用环境变量覆盖：`DSH_HOME`（默认 `%USERPROFILE%\.dsh`）、`DSH_PROFILE`（默认 `desktop`）、
`DSH_PNPM`（pnpm.cjs 绝对路径）。

#### ⚠️ `DSH_PROFILE` 的默认值会骗你

`DSH_PROFILE` 的默认值是 `desktop`，但**实际目录名不一定叫这个** —— 新版 DSH 的 profile 目录会带后缀，
本机是 `desktop-017`。指错了目录，脚本不会报「目录不存在」，而是对着那个空目录跑完一整套校验，
输出一堆「缺失 / 未登记 / package.json 缺失」—— 全是**假警报**，真正的问题只是看错了地方。

```powershell
Get-ChildItem "$env:DSH_HOME\profiles" -Directory | Select-Object -ExpandProperty Name
$env:DSH_PROFILE = '<上一步查到的名字>'
```

#### ⚠️ pnpm 不一定在 `resources\runtime\` 下

`findPnpm()` 只在 `%LOCALAPPDATA%`、`%LOCALAPPDATA%\Programs`、`C:\Program Files` 里
搜名字匹配 `deepseek|dsh` 的目录，再拼 `resources\runtime\pnpm\bin\pnpm.cjs`。从源码目录跑的 DSH
（例如本机的 `…\EduWork-ECNU\resources\product\d\`）**自动搜不到**，必须显式指定：

```powershell
$env:DSH_PNPM = 'C:\Users\<你>\EduWork-ECNU\resources\product\d\node_modules\pnpm\bin\pnpm.cjs'
```

#### ⚠️ `#main` 会走 SSH，GitHub 443 还会抖

依赖写成 commit SHA 时 pnpm 不需要解析 ref，直接下 codeload 压缩包；写成分支名（`#main`）时 pnpm 会先
`git ls-remote`，而且会把地址规范化成 `git+ssh://git@github.com/…` —— 没配 SSH key 直接
`Host key verification failed`。要在本机跟 `main`，先加这两条 git 配置（详见
[README](../README.md) 安装一节的《跟 `main`：先掰掉 ssh》）：

```powershell
git config --global --add 'url.https://github.com/.insteadOf' 'git+ssh://git@github.com/'
git config --global --add 'url.https://github.com/.insteadOf' 'ssh://git@github.com/'
```

另外 GitHub 的 443 时通时断：实测**同一条** `git ls-remote` 2 秒通、21 秒超时都出现过。
`deploy.mjs` 失败不一定是你配置错了，重试一次；连续失败再排查。

### 3. 生效

```
node scripts\deploy.mjs --enable   # 1) 挂进 bundles（已挂则无操作）
node scripts\deploy.mjs            # 2) 重新部署最新源码 + 校验不变量
node scripts\mount-check.mjs       # 3) 挂载路径检查（内部串 contract-test）
# 4) 完全退出 DSH 再重新启动 —— 然后在「新会话」里验收
```

**必须开新会话**：旧会话的历史消息里已经录下了修复前的失败工具调用，以及那份残缺的工具名快照，
旧记录无法修复，只会在新会话里干净地重建。

## 五个自检夹具

| 脚本 | 覆盖的失败面 | 是否走宿主真实代码 |
| --- | --- | --- |
| `selftest.mjs` | 工具**业务逻辑**：注册 + 逐个执行（含一次真实 `dotnet build`）、`mode=docs` 判定的三类反例、`needScreenshots` 兜底、`kirara_docsync` 的变化定性、发布链路（三端 `release_notes` + `dryRun` 计划 + 一个**合成 git 仓库**钉住提交分类与去重规则） | ✗ 假 `ctx.tools` |
| `deploy.mjs` | **部署形态**：profile 副本 == 源码、profile 里无宿主包副本 | ✗ 只做文件/清单断言 |
| `mount-check.mjs` | **解析归层**：复现 `routeScoped` 的两锚点判定 + 清单形态 | ✗ 模拟判定 |
| `contract-test.mjs` | **真实调度链路**：真 `cordis.Context` + 真 `ToolRuntime`，逐个 `prepare()` | ✓ 全真 |
| `cache-budget.mjs` | **前缀缓存预算**：工具目录逐字节稳定 + 描述无易变内容 + 每个工具的返回值不超预算 | ✗ 假 `ctx.tools`（含一次假 `gradlew.bat` 真派发） |
| `contract-test.mjs` 的 §6.5 | **可选键边界**：`artifact` / `screenshotReview` / `needScreenshots` 三类条件展开键，以及 `mode=docs` 的短路分支 | ✓ 全真 |
| `contract-test.mjs` 的 §6.7 | **发布链路端到端**：临时仓库 + 假发布脚本，但真找产物、真改名、真搬目录、真算 SHA256、真写 `.sha256`；以及 README 门禁的拦下 / `force` 放行 / 提交后自动放行三段行为 | ✓ 全真 |

```powershell
node scripts\deploy.mjs          # 部署最新源码到 profile + 校验不变量
node scripts\selftest.mjs        # 工具级自检
node scripts\mount-check.mjs     # 挂载路径检查（内部会串 contract-test.mjs）
node scripts\contract-test.mjs   # 只跑真实契约测试
node scripts\cache-budget.mjs    # 前缀缓存预算回归（改 description / 输出预算后必跑）
```

### 为什么要有 `cache-budget.mjs`

这个插件对 DSH 前缀缓存的全部影响面只有两处，而且都能被机器检查：工具目录必须逐字节固定
（否则 DSH 开新 request series 并原地改写系统提示节点，整段前缀作废），以及每个工具的返回值
必须有硬预算（否则上下文更快触到压缩阈值，而 compaction 同样作废整段前缀）。机制细节见
[README「前缀缓存与上下文预算」](../README.md#前缀缓存与上下文预算为什么输出压得这么小)。

夹具里写死的预算常量是**回归基线**：改了插件默认值就得显式改它，否则夹具会拦下来。
当前基线（`cache-budget.mjs` 的 `BUDGET`）：

| 常量 | 值 | 实测 | 说明 |
| --- | --- | --- | --- |
| `toolSchemaBytes` | 9500 | 9065（10 个工具） | 8 个工具时 6496；`kirara_release` + `kirara_release_notes` 带来 +2565 的一次性常驻增量 |
| `docsRenderChars` | 4400 | 4014 | 宽泛关键词 + `maxHits=40` |
| `buildRenderChars` | 5600 | 5124 | 200 行 × 400 字符的假构建日志 |
| `startRenderChars` | 1400 | 1356 | 长需求 + `auto`（含 UI + 文档同步两条额外步骤） |
| `verifyRenderChars` | 2000 | 1412 | `purpose=ui-design` + 截图，协议最长 |
| `docsyncRenderChars` | 2500 | 1440 | 三端混合、4 篇目标 |
| `narrativeHardCap` | 2400 | 2444（含截断说明） | `textBudgetChars` 默认值；原 1600，因为 UI 设计复核协议被截断即失效 |
| `releaseNotesRenderChars` | 3600 | 3243 | `releaseNotesBudgetChars`（3200）+ 头部；取后端仓库这个最大区间 |
| `releaseRenderChars` | 3400 | 450 | `releaseBudgetChars`（3000）+ 头部；`dryRun` 计划 |
| `releaseNotesHardCap` / `releaseHardCap` | 3200 / 3000 | 3243 / 3044 | 这两个是有意做得比 `narrativeHardCap` 宽的：产出是提交清单与步骤表，压到 2400 会把「需人工判断」桶整个挤掉 |

`kirara_start` 的 1400 只剩 44 字符余量：往 `steps` 里再加一条就会红。
这是有意的 —— 流程说明每次调用都会重放进上下文，它是最该被盯住的一段。

### 为什么 `contract-test.mjs` 才是关键

`selftest.mjs` 用假的 `ctx.tools.register`，**从不经过宿主的 `ToolRuntime`** —— 这正是
「自测全绿、真机全崩」的盲区。`contract-test.mjs` 补上这一环：

```text
=== 2. 真实 cordis Context + ToolRuntime ===
  ✓ ToolRuntime 已作为 ctx.tools 服务挂载
  ✓ TOOL_RUNTIME_SCHEDULER 可解析且带 prepare()
=== 3. 加载插件并 apply() ===
  ✓ apply(ctx, config) 未抛异常
  ✓ 真实 ToolRuntime 里找到全部 10 个 kirara_* 定义
=== 4. 真实调度器 prepare()（每个工具） ===
  ✓ kirara_start: prepare → dispatch      arguments = {"request":"…"}
  ✓ kirara_profile: prepare → dispatch    arguments = {}
  …
=== 5. presentCall() 视图形状 ===
  ✓ 十个全部 card=generic / title 非空 / kind ∈ ToolCallKind
=== 6. 完整链路 prepare → dispatch → finish（kirara_profile） ===
  ✓ 工具体执行成功（isError 非 true）
=== 6.5 工具返回值 lossless JSON 边界（10 个工具真派发） ===
  ✓ 返回值可被宿主接受
  ✓ kirara_build 构建成功但无 APK: 返回值为 lossless JSON    exit=0、无产物 ⇒ artifact 必须省略而不是 undefined
  ✓ kirara_verify full 无截图（screenshotReview 必须整体省略）: 通过
  ✓ kirara_start @ 提及类请求: 未降级为 small       mode=full
  ✓ lib/impl.js 没有「显式赋 undefined」的返回字段
=== 6.6 端到端真构建 kirara_build api（可选，加 --live-build） ===
  ✓ 真实 api 构建经宿主返回      ✅ 构建成功 — api  (1.4s, exit=0)
=== 6.7 发布链路端到端（假发布脚本 + 真实文件系统） ===
  ✓ desktop 产物已按 _v<版本> 命名并落到输出目录   Kirara_Server_APP_Setup_x64_v1.6.6.exe
  ✓ desktop 校验码是 sha256sum 格式（HASH *文件名）
  ✓ README 本轮没更新过时：发布被门禁拦下
  ✓ README 改动提交进本轮区间后自动放行（无需 force）
  ✓ media 脚本没留校验码时由插件补写，不出现半成品
  ✓ media 校验码与实际不符时判定失败
=== 7. 模块身份唯一性 ===
  ✓ profile 里没有 dsh-tools 副本        ✓ profile 的 @deepseek-ai/ 为空
```

它通过 `scripts/host-interception.mjs`（Node 的 `module.register` 解析钩子）复现了宿主的拦截语义：
宿主作用域内的包名一律指向宿主那一份，本地候选不参与 —— 这正是 `routeScoped` 在「无物理候选」时的行为。
**被测入口默认是 profile 里已部署的副本**，不是源码树。

第 6.5 节用**临时 workspaceRoot + 假 `gradlew.bat`** 把 `kirara_build` 真派发一遍
（毫秒级、不碰任何真实工具链），因为「构建完成但没有产物」正是 media 的真实失败面。
它同时把其他 6 个工具也真派发一次 —— 返回值边界是全工具的共性约束。

## `selftest.mjs` 输出样例

```text
=== 0. kirara_start（一句话启动，两种走向都要对） ===
[a] 小功能 auto      -> mode = small | blocked = false
[b] 破坏性 auto     -> mode = full  | blocked = true
[c] 空请求          -> blocked = true | decisions = 1
[d] docsToRead 条数 = 1 | 每端最多 4 篇 = true
…
ok = true  exit = 0  duration = 2.3s
=== 全部工具执行完毕，插件自检通过 ===
```

## 部署不变量

`deploy.mjs --check` 断言的内容，共 9 项：

| # | 不变量 | 为什么必须有 |
| --- | --- | --- |
| 0 | profile 已登记本插件（`dependencies` 里有） | 没登记就物化不到 `node_modules` |
| 1 | 插件清单：宿主包**不是** `dependencies` | 否则 pnpm 会把宿主包铺进 profile |
| 1-peers | 插件清单：宿主包**声明为** `peerDependencies` | 声明不对的话宿主 runtime resolution 不会为它们做拦截 |
| 1b | lockfile 不把宿主包当运行期依赖 | 锁文件是最终的安装意图，残留旧锁会诱导后来者把 `dependencies` 加回去 |
| 1c | 插件清单：展示元信息可解析（`exports["./locale/*.json"]` + `locale/en.json`） | 这条最容易静默失效，DSH 只会「当作没有元信息」、列表回退显示原始包名，不报任何错 |
| 2 | profile 的 `node_modules` 下没有 `@deepseek-ai` / `@standard-schema` 物理副本 | 模块身份唯一性的结构性兜底 |
| 3 | profile 副本与源码**逐字节一致**（10 个文件：`package.json`、`lib/{index,impl,update,client,build-info}.js`、`cordis.patch.yml`、`README.md`、`locale/*.json`） | `file:` 安装是**拷贝**，不是软链 |
| 4 | 从副本入口 `require.resolve.paths()` 扫不到任何宿主包候选 | 运行时解析路径必须落在宿主侧 |
| 5 | 副本 `lib/index.js`（引导层）存在且 > 512 B、`lib/impl.js`（实现层）> 1024 B | 防「假装部署成功」的空文件或空壳 |

任一项失败 ⇒ exit 1。

`bundles` 里是否包含本插件**不算失败项**。它由 `printReport()` 单独以 `!` 开头提示，
因为「没挂载」不等于「坏了」——`--check` 仍然返回成功。

## 改完代码怎么生效

| 改了什么 | 怎么生效 |
| --- | --- |
| `lib/impl.js`（实现层：工具、流程、`PROJECTS`） | **在插件详情页点「同步更新」**（或 `node scripts/deploy.mjs` 重新部署）—— 引导层会热重载它，不需要重启 DSH |
| `lib/index.js`（引导层）/ `lib/update.js`（内核） | `node scripts/deploy.mjs` 重新部署 + **完全重启 DSH**（引导层必须是启动时加载的那份） |
| `cordis.patch.yml` / `package.json` | 重新部署 + **完全重启 DSH**（这两个只在启动时读一次） |
| `lib/client.js`（浏览器半边） | 同步更新/重新部署后**刷新一次页面** |
| `PROJECTS` / `SAFETY_RULES` | 同 `lib/impl.js` |
| 任一工具的 description / 参数 / 输出预算 | 先跑 `node scripts/cache-budget.mjs`，同步 `BUDGET` 基线，再部署 |
| `locale/{zh,en}.json` | 重新部署（`deploy.mjs` 逐字节比对，漂移只会静默显示旧文案） |
| 想验证本轮改动是否真的进了 profile | `node scripts/deploy.mjs --check`（有漂移 exit 1） |
| 想验证自更新链路本身 | `node scripts/update-e2e.mjs`（离线，18 项断言）、`node scripts/update-live-check.mjs`（联网打真 GitHub）、`node scripts/check-kernel-parity.mjs`（两仓库内核一致） |

**改完在任何会话里都建议先跑一遍三条夹具**：`selftest` 抓业务逻辑、`contract-test --from source` 抓真实
调度链路、`cache-budget` 抓前缀缓存。三条都过再部署，能省掉一轮「重启 DSH 才发现又崩了」。
