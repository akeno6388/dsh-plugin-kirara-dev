# 故障排查

## 先判断插件到底加载了没

不要押在插件检查器上 —— 某些会话的工具表里根本没有 `cordis_inspect_*`。**验收要建立在会话自己
能观察到的证据上**：

1. 工具表里有 8 个 `kirara_*`：`kirara_start` / `kirara_profile` / `kirara_docs` / `kirara_route` /
   `kirara_build` / `kirara_verify` / `kirara_docsync` / `kirara_summary`
2. **真调一次看返回值**：`kirara_profile({ project: 'desktop' })` 应给出正确的 `workspaceRoot` 与
   `buildLine`；`kirara_docs({ keywords: ['Kirara'] })` 应命中真实文档路径；
   `kirara_docsync({ feature: '修复登录失败', changes: [] })` 应给出文档清单而不是报错
3. **同一会话里内置 `read` / `pwsh` 正常** —— 下面那个「所有工具调用全崩」的事故里，
   它们是和 `kirara_*` 一起崩的

工具**总数不是判据**。会话形态不同，工具数量会浮动，只要 `kirara_*` 八个齐全即为通过。

### 重启后的验收

1. 工具表里八个 `kirara_*` 全部出现（不必数总数）
2. 在同一会话里调一次内置 `read` 或 `pwsh`；若 `pwsh` 只报
   `Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<目录>)`，
   那是沙箱 ACL 的前置条件问题，与插件无关，见下文
3. `kirara_profile({})` 应返回 `workspaceRoot`、`projects = desktop, api, media`、`missing = []`，
   且三条构建命令与 [架构与项目画像](architecture.md) 里列的一致

还崩 `prepare` 的话，跑到插件目录执行 `node scripts\deploy.mjs --check` —— 它会直接指出
profile 里残留的宿主包副本，那就是根因。

### 如果能用插件检查器

它返回宿主 `Tool` 注册表的权威列表（"Return every Tool schema currently callable by this Agent"）：

```
cordis_inspect_query({ platform: 'host', provider: 'Tool', method: 'listTools' })
```

价值在于**能区分两种失败**：

| `listTools` 结果 | 含义 | 该查什么 |
| --- | --- | --- |
| 有 `cordis_inspect_*`、无 `kirara_*` | 运行时正常，插件没被加载 | bundle 声明 / profile 依赖 / 补丁文件路径 |
| 连 `cordis_inspect_*` 都异常 | 会话或检查器本身有问题 | 与插件无关，先修会话 |

比看进程启动时间靠谱 —— 它是运行时的自我报告，不是外部推断。

## 事故一：所有工具调用崩在 `Cannot read properties of undefined (reading 'prepare')`

**现象**：启用插件后，某个会话里**所有**工具调用全部崩掉 —— 包括内置的 `read` 和 `pwsh`。
模型于是反复重试并烧光上下文，整个开发流程中断。

**曾被怀疑但被证伪的方向**：旧会话历史固化了工具名快照，与当前注册表不一致。
实测崩溃会话的注册表里根本没有 `kirara_*`，照样崩；改会话历史也没用。

**真实根因**：

```
插件 package.json 把 @deepseek-ai/dsh-tools / schemastery 声明成 dependencies
        ↓  pnpm install（nodeLinker: hoisted）
profiles/desktop/node_modules/@deepseek-ai/ 出现 6 个物理副本
        （dsh-tools / schemastery / dsh-brand / dsh-util-values / cosmokit / @standard-schema-spec）
        ↓  app-boot routeScoped()：物理候选存在 ⇒ kind:'native'（本地赢过拦截）
宿主加载了第二份 dsh-tools（tools 服务来自 profile 副本）
        而 dsh-agent-loop 用的是安装目录那一份
        ↓  TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler') 是模块私有
两个 Symbol ≠ 同一个 ⇒ registry[SYMBOL] === undefined
        ↓  dsh-agent-loop 每次派发
ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)  ⇒  undefined.prepare(...)
```

关键是它**与插件是否在 bundles 里无关** —— 只要那几份物理副本还留在 profile，就会持续崩。

**修复**：

1. `package.json`：`dependencies` → **`peerDependencies`**
2. 清空 profile 的 `node_modules` 重装：`Packages: -6`，`@deepseek-ai/` 与 `@standard-schema/`
   直接消失；`pnpm-lock.yaml` 从 3332 B 缩到 800 B，两个宿主包从 `dependencies` 段移到
   kirara 条目的 `peerDependencies:` 段
3. 加硬性不变量（`deploy.mjs` 断言）：profile 副本的 Node 解析路径里不得存在任何宿主包候选；
   lockfile 也不得把宿主包记成运行期依赖

**可复用的结论**：插件对宿主包声明 `dependencies` 会通过包管理器的提升机制**静默污染宿主 profile**；
`routeScoped` 里「物理副本优先于拦截」使这个污染不可逆地分裂模块身份；而模块身份分裂的唯一表征
是一个 `undefined` 的属性读取。假 `ctx` 的自测永远看不到这一层 —— 所以后来补了 `contract-test.mjs`。

## 事故二：`tool "kirara_build" returned invalid output`

**现象**：`kirara_build project=api` 在 DSH 里 **100% 失败**，返回

```text
Error: tool "kirara_build" returned invalid output: value is not lossless JSON
```

文案带 `tool "…"` 前缀，看着像 harness 自己的毛病，实际是**插件返回值违规**。
当时 API 构建本身是成功的，所以现场表现是「构建明明过了，工具却报错」。

**影响面**：`PROJECTS` 里只有 media 声明了 `apk`，而 `artifact` 仅在 APK 真实存在时才赋值，
所以 api / desktop 这两端的构建验证从来没成功返回过；另一条触发路径是
`exitCode: r.code ?? undefined`，超时或启动失败时 `code` 为 `null`，连 media 的超时路径也一起坏掉。

**宿主的判定**（`@deepseek-ai/dsh-util-values` 的 `walkJsonValue`）：

| 返回形状 | lossless 快照 | output schema |
| --- | --- | --- |
| 缺键（条件展开省略） | ✅ | ✅ |
| `exitCode: undefined` | ❌ `snapshotJsonValue` 返回 `undefined` | ❌ `"value" must be a lossless JSON object` |
| `exitCode: null` | ✅ | ❌ `"value.exitCode" must be an integer` |
| 嵌套 `undefined` / 数组洞 / `NaN` | ❌ | ❌ |

对象分支是**逐键 visit** 的，值为 `undefined` 的自有可枚举键会直接判负 ——
不存在「`JSON.stringify` 会顺手丢掉」的侥幸。

**修复**：可选键一律**整键省略**，不要赋 `undefined`：

```js
...(r.code == null ? {} : { exitCode: r.code }),
...(artifact === undefined ? {} : { artifact }),
```

不能用 `?? null` 兜 —— `exitCode` 在 schema 里声明为 `integer`，`null` 会被 `must be an integer`
拒掉。同文件其他几处的 `apk: p.apk ?? null` 之所以合法，是因为那些键的 schema 允许 `null`。

**为什么自测没抓到**：两个盲点同时生效。`selftest.mjs` 直调 `execute()`，绕过了宿主的快照与 schema
校验，本地 `exit=0` 而宿主必拒；`contract-test.mjs` 当时只对 `kirara_profile` 做了完整 dispatch，
而它的返回值恰好干净 —— 夹具只检查 `prepare()` 的形状，从不检查返回值。

## 事故三：`kirara_verify` 每次都返回 invalid output

修完 `kirara_build` 后，`kirara_verify` 的收尾仍是旧写法：

```js
return Promise.resolve({ skipped: false, steps, howToInstall, screenshotReview });
//                                                                 ^^^^^^^^^^^^^^^^
//                            无 screenshots 时恒为 undefined ⇒ 整个调用被宿主拒收
```

`mode=full` 且没传 `screenshots` 就必现；`mode=small` 走提前 return，反而侥幸正常。

**为什么上一条的新守卫没拦住**（两条守卫同时有缝）：

1. `contract-test.mjs` 确实派发了 `kirara_verify`，但 `sampleFor` 给 `mode` 造的样本是 `'auto'`，
   而「是否生成截图协议」只取决于 `screenshots` —— 参数组合恰好绕开了出错的那条分支。
   **「派发过了」不等于「覆盖到了」。**
2. 静态审计正则是 `/^\s*(\w+):[^,\n]*?\bundefined\b\s*,?\s*$/`，要求 `undefined` 之后必须是逗号
   或行尾。事故那行是 `screenshotReview });` —— `undefined` 后面直接跟 `}`，整条被正则漏掉，
   于是 4 个 ✓ 全绿而 bug 健在。

**修复**同事故二的手法：

```js
return Promise.resolve({
  skipped: false,
  steps,
  howToInstall,
  ...(screenshotReview ? { screenshotReview } : {}),
});
```

**加固后的守卫**：运行时显式补两种入参（无截图 / 带截图），断言协议段出现时机与 `screenshots`
一致、正文不得出现 `undefined` 字样；静态审计正则放宽，补上「裸标识符后跟 `}` / `)`」这一形态。

**后续增量（同一个坑的第三、第四个入口）**：`kirara_verify` 新增了 `needScreenshots`，
`kirara_docsync` 新增了 `missing` —— 又都是「条件成立才有」的可选键。
所以 `contract-test.mjs` 的 §6.5 现在按参数组合逐条派发：

| 入参 | 断言 |
| --- | --- |
| `full` 无截图（summary 不含界面词） | `screenshotReview` 整体省略、`needScreenshots` 不出现 |
| `full` + `screenshots` | `screenshotReview` 出现且 `purpose` 正确 |
| `full` + 界面词 summary（不传 `purpose`） | `needScreenshots` **必须**出现（模型忘传 purpose 时的兜底） |
| `mode=docs` | 走 `skipped`，两个可选键都不出现 |
| `kirara_docsync` 在空文档 root 下 | `targets` 为空但 `missing` 非空，仍是合法 JSON |

**可复用的结论**：每加一个「条件成立才有」的返回字段，就多一个 `undefined` 入口。
加字段时同时把入参组合写进 §6.5 —— 「派发过了」不等于「覆盖到了」。

## 事故四：会话里 `pwsh` 全崩于 `SetNamedSecurityInfoW failed (Win32 5)`

**现象**（工作区在 `D:` 盘）：会话里所有 `pwsh` 调用失败，哪怕只有 `Get-Location`：

```text
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\works\Kirara Server Project)
```

而 `kirara_*` 八个工具完全正常 —— 它们走自己的子进程、**不经过沙箱**，所以那段时间反而是唯一
还能干活的工具。同一台机器上，工作区在 `C:` 用户目录的会话从不报这个错。

**根因**（DSH 自带 `dsh-sandbox-windows-acl` 的文档原文）：

> Granted directories must be caller-owned and grant `WRITE_OWNER` — the owner's implicit rights
> cover only `READ_CONTROL` and `WRITE_DAC`; the label lives in the SACL, so the combined apply
> additionally needs `WRITE_OWNER` (a Full-control directory, the normal workspace case, has it).
> A directory whose DACL grants only Modify now fails the grant loudly.

`D:` 卷根目录的默认继承 ACL 只给子目录 `Authenticated Users:(M)`（Modify），没有 `WRITE_OWNER`；
`C:\Users\<你>` 树默认带当前用户 `(F)`。沙箱要在工作区根上写完整性标签（SACL，需 `WRITE_OWNER`），
于是必崩。

**修复**：用 DSH 官方技能 `diagnose-windows-sandbox-acl`，诊断加修复一条命令，不需要提权、不需要 UAC。
对**失败路径（也就是工作区根）**执行，`-AllowRoot` 与 `-Path` 相同即可自我修复。
每个「非系统卷上的工作区根」各修一次，父目录也要。

**无需重启 DSH** —— 授权失败不会被缓存，下次调用重新物化即成功。

> 顺带排除一个假嫌疑：没装 PowerShell 7 不是原因。`pwsh` 工具会自动回落到 Windows PowerShell 5.1，
> `dsh-pwsh-local` 的解析顺序是 `%ProgramFiles%\PowerShell\7\pwsh.exe` → `PATH` 里的 `pwsh.exe`
> → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` → `pwsh`。

## 常见故障速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 工具表里没有 `kirara_*` | bundle 未注册，或 DSH 没重启 | 检查 profile 的 `dsh.profile.bundles`，完全重启 DSH，开新会话 |
| 工具调用全崩在 `undefined.prepare` | profile 里有宿主包物理副本 | `node scripts\deploy.mjs --check` 定位，然后重新部署 |
| 工具返回 `value is not lossless JSON` | 返回值里有值为 `undefined` 的自有键 | 改成整键条件展开 |
| `kirara_profile` 的 `workspaceRoot` 不对 | 没配置也没设 `DSH_WORKSPACE` | 在 profile 的 `cordis.patch.yml` 里覆盖，或设环境变量 |
| `pwsh` 报 `SetNamedSecurityInfoW failed` | 工作区目录缺「当前用户完全控制」ACE | 跑 `diagnose-windows-sandbox-acl` |
| 改了源码但行为没变 | `file:` 安装是拷贝，副本没刷新 | `node scripts\deploy.mjs` |
| 明明是改文档，却被判成 `full`/`small` 要构建 | `mode=docs` 的判定词表刻意保守（缺「章节/段落」这类结构词） | 显式传 `mode: 'docs'` |
| `kirara_verify` 反复要求先给截图 | **不是故障**：UI 改动必经截图（`needScreenshots`），不看图就改样式等于盲改 | 截图后带 `purpose: 'ui-design'` 再调一次 |
| `kirara_docsync` 推荐的文档打不开 | 规则命中了不存在的路径（`PROJECTS.docs` 里的死链） | 看返回里的 `missing` 字段，修 `PROJECTS[].docs` |
| 工具 schema 字节数超了 `cache-budget` 基线 | 新增工具或把 description 写胖了 | 跑 `node scripts\cache-budget.mjs`，确认增量值得后再改 `BUDGET` |
