# 自更新（在插件管理页里同步 GitHub）

> 目标：不用重装、不用重启 DSH、不用碰 pnpm，在 DSH 的「插件管理 → 本插件详情页」点一下，
> 就把插件切到 GitHub 上的最新提交，并且**当场生效**。

## 怎么用

1. 打开 DSH 的插件管理页，进入 **Kirara 项目开发流程** 这个 bundle 的详情页；
2. 标题旁会有一个徽标（@已是最新@ / @有新版本 abc12345@）；
3. 页头两个按钮：**检查更新**（只查询，不动文件）、**同步更新**（下载 + 替换 + 热重载）；
4. 页尾「GitHub 更新」区段：仓库/分支、当前提交、远端提交、上次检查时间、更新日志，以及**回滚**按钮。

宿主半边（工具、路由、构建/验证流程）同步后立刻生效，**不需要重启**。
浏览器半边（本插件在「插件管理」页里那几个控件）如果自身有改动，**刷新一次页面**即可。

## 它是怎么做到「不重启」的

DSH 官方的 HMR 只管配置：改 profile patch 里的配置项，运行中的进程会立刻生效；
但**替换已安装包的版本**按官方文档需要重启，模块级监听还必须在启动前配好。

所以这里换了一条路 —— cordis 公共 API 上的「子 fiber 换实现」：

~~~
lib/index.js    引导层（很薄，几乎不变）
                 ├─ 把 lib/impl.js 挂成自己的子 fiber
                 ├─ 跑自更新状态机（查 GitHub / 下载 / 解包 / 覆盖 / 备份）
                 ├─ 暴露同源路由给浏览器半边
                 └─ 同步成功后：dispose 旧实现 → import('…/impl.js?v=<sha>') → 重新挂载
lib/impl.js     真正的实现（工具、流程、发布……）
lib/update.js   自更新内核（查远端 / 下产物 / 解 tar.gz / 状态机 / 回滚）
lib/client.js   浏览器半边（详情页徽标 / 按钮 / 区段）
lib/build-info.js 发版印章（随包这一份对应哪个提交）
~~~

同步一次会依次做六件事：

1. @GET https://api.github.com/repos/<owner>/<repo>/commits/<channel>@ 拿远端 sha
   （失败退回 @https://github.com/<repo>.git/info/refs?service=git-upload-pack@，不吃 API 限额）；
2. @GET https://codeload.github.com/<repo>/tar.gz/<sha>@ 下载源码包；
3. 用内置的极简 ustar 解包器解开（**零第三方依赖**，否则 pnpm 会把它装进 profile）；
4. 校验产物（@package.json@ 的 name 必须是本包、必须含 @lib/impl.js@）；
5. 把 @lib/@ 与 @locale/@ 覆盖进已安装包目录，覆盖前把旧文件整份备份；
6. 引导层 dispose 旧实现并用 @?v=<sha>@ 重新 import 新实现 —— **这一步就是「实时生效」**。

新实现挂载失败时会自动把旧实现装回去（并把错误写进更新日志），不会把插件留在半死状态。

## 产物落在哪

~~~
<DSH_HOME>/kirara-plugins/@kirara/dsh-plugin-kirara-dev/
├── state.json                 当前/上一个提交、远端检查结果、历史
├── releases/<sha>/            下载下来并解开的产物（有 .kirara-release.json 标记，可复用）
└── backups/<sha>-<时间戳>/     被覆盖前的 lib/ 与 locale/（回滚就是把它拷回去）
~~~

包目录里会多一个 @release.json@，记录「现在这份是哪个提交同步来的」；
引导层据此判断该挂 @随包实现@ 还是 @已同步实现@（包被 pnpm 重装后会自动回到随包版本）。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| @updateChannel@ | @main@ | 跟随哪个分支/标签 |
| @updateAutoCheck@ | @true@ | 启动后自动查一次（只查不装），之后每 6 小时一次 |
| @updateStoreRoot@ | 空 | 留空 = @<DSH_HOME>/kirara-plugins@ |
| @updateRoutePath@ | @/kirara-dev-update@ | 宿主路由前缀，也是浏览器半边取状态的地方 |

配置写在 profile 的 @cordis.patch.yml@ 里（@- id: kirara-dev@ 那一行）。改配置是**立刻生效**的
（配置级 HMR 是好的），改完不需要重启。

## 边界与已知限制（都实测过）

- **浏览器半边要刷新页面**：宿主侧热重载不影响已经加载进浏览器的 JS。
- **pnpm 会还原**：在 profile 里跑一次会重新解析依赖的 @pnpm install@，会把包目录恢复成
  清单里那个版本；这不算故障 —— 引导层发现 @release.json@ 与实现不匹配时会回到随包实现。
  想要「一直跟着 GitHub 走」，就别再对这两个包做 pnpm 重装。
- **需要能连上 GitHub**：本机实测 API 200（0.7s）、codeload 133 KB（3s）。走 DSH 的统一代理策略
  （普通 @fetch@ 即可，不用自己造代理）；失败原因会原样写进更新日志与 @state.json@。
- **一次只允许一个同步任务**：重复点击会得到「已有更新任务在进行中」，不会并发覆盖文件。
- **产物目录必须可写**：@<DSH_HOME>/kirara-plugins@ 与插件包目录都要可写。

## 开发者

~~~powershell
node scripts/update-e2e.mjs          # 离线端到端：假 GitHub + 真 cordis + 真引导层，18 项断言
node scripts/update-live-check.mjs   # 联网打真 GitHub：验证真 codeload 产物能被解开并应用
node scripts/client-panel-test.mjs   # 无浏览器验证详情页控件（伪造 __ModuleLoader__ + slots，react-dom/server 真渲染，--dump 看 HTML）
node scripts/check-kernel-parity.mjs # 本仓库 lib/update.js 与另一个插件仓库是否逐字节一致
node scripts/stamp.mjs               # 发版前写入 BUNDLED_SHA（--check 只校验）
~~~

⚠️ @lib/update.js@ 在 @dsh-plugin-kirara-dev@ 与 @dsh-plugin-kirara-theme@ 两个仓库里是**逐字节相同的副本**
（两个仓库各自独立发布，没有共享包）。改动内核必须两边同步，@check-kernel-parity.mjs@ 会挡住漂移。
