# DSH 插件契约

插件要怎么写才会被 DSH 认可、加载、并且工具能被真正派发。以下内容逆向自 DSH 自带插件，
并在 `0.2.0-rc.2` 上实测通过。

## 模块导出

插件是 **ESM 模块**，必须具名导出：

```js
export const name = 'kirara-dev';        // 插件名
export const inject = ['tools'];          // 依赖的 DSH 服务
export const Config = z.object({...});    // @deepseek-ai/schemastery
export function apply(ctx, config) {      // 注册入口
  ctx.tools.register(defineTool({ ... }));
}
```

## `defineTool` 的形状

来自 `@deepseek-ai/dsh-tools`：

```js
defineTool({
  name: 'tool_name',
  description: '给模型看的说明',
  parameters: {                       // ParameterSchemaSpec，不是标准 JSON Schema
    foo: { type: 'string', required: true, description: '…' },
    bar: { type: 'string', enum: ['a', 'b'] },   // 可选：整个省略 required
  },
  output: {
    schema: { /* ValueSchemaSpec，同上 */ },
    render: (args, value) => [{ type: 'text', text: '…' }],
  },
  execute(args, exec) { /* 返回 value 或 Promise */ },
  presentCall: (args) => ({ card: 'generic', title: '…', kind: 'other' }),
});
```

### 三个会直接抛 `JsonSchemaError` 的硬性校验

这三条会让插件整段加载失败：

1. **`required` 为真时，该键必须出现在同级 `properties` 里。**
   ```js
   { type: 'object', properties: { a: {...} }, required: true }    // ✗ properties.required must be true when present
   { type: 'object', properties: { a: {...} }, required: {...} }   // ✓
   ```
   错误原文：`unsupported JSON schema: schema.properties.X.required must be true when present`。

2. **可选字段写 `required: false` 也会报错** —— 编译器要求 present 时必为 `true`。
   正确写法是整个省略 `required`。

3. **`apply()` 里抛异常会静默终止加载。** 某些宿主下进程 `exit 0` 且没有堆栈。
   调试时务必自己在 `apply` 外层套 `try/catch` 打印 `err.message`。

## Bundle 契约

插件包要作为 bundle 被 DSH 识别，`package.json` 必须声明：

```json
{
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 顶层是**数组**，元素形如 `- insert: [ <entry> ]`，entry 的 `name` 是 ESM 模块
说明符，`config` 会**整行替换**，不是深合并。

## 加载器契约

摘自 `@deepseek-ai/dsh-app-boot` 的 `profile.js` 文档注释：

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

对应到本插件：

| 契约 | 落实方式 |
| --- | --- |
| Bundle = 声明 `dsh.bundle.patch` 的 npm 包 | `package.json` 里 `dsh.bundle.patch = "./cordis.patch.yml"` |
| 按 `bundles` 顺序叠加在空 entry 列表上 | `@deepseek-ai/dsh-base` → `dsh-web-app` → `@kirara/dsh-plugin-kirara-dev` |
| 解析锚点：dsh 安装 → profile 目录 | 插件本体从 profile 的 `node_modules` 命中；宿主包必须走「无本地候选 → interception」那条路，由安装锚点提供 |
| 补丁路径 = `join(packageDir, patch)` | 实际读取 `<repo>/dsh-plugin-kirara-dev/cordis.patch.yml` |

两个直接推论：

- 改完 `cordis.patch.yml` 或 `package.json` **必须重启 DSH**，这两个只在启动时读一次；
  只有改 `lib/index.js` 才有机会被热加载。
- `file:` 安装是**拷贝**，改完源码要重新部署才会传染到 profile。

## 宿主包必须声明为 `peerDependencies`

插件用到 `@deepseek-ai/dsh-tools`（提供 `defineTool`）与 `@deepseek-ai/schemastery`（配置校验），
两者由宿主提供：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-tools": "^0.2.0-rc.2",
  "@deepseek-ai/schemastery": "~3.18.4"
}
```

**不要把这两个包声明成 `dependencies`，也不要在插件目录里 `npm install` 它们。**

一旦它们在 profile 的 `node_modules` 里出现物理副本，`app-boot` 的 `routeScoped()` 会判定
`kind: 'native'`（本地物理副本优先于拦截），宿主于是加载第二份 `dsh-tools`。
`TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler')` 是模块实例私有的，
两份副本 = 两个 Symbol，`ctx.tools[SYMBOL]` 变成 `undefined`，
于是每次工具派发（包括内置的 `read` / `pwsh`）都崩在
`Cannot read properties of undefined (reading 'prepare')`。

DSH 自己的包也是同款做法：`dsh-tools` 把 11 个 `@deepseek-ai/dsh-*` 兄弟包全部声明为
`peerDependencies`，只留 3 个真实 `dependencies`。

开发期确实需要在插件目录里放一份宿主包（离线跑自检用），所以它们在 `package.json` 里声明为
**`devDependencies`**（带确切版本）。`devDependencies` 永远不会被包管理器装进依赖方，
因此这条路不会污染 profile：

```json
"devDependencies": {
  "@deepseek-ai/cordis": "4.0.4",
  "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
  "@deepseek-ai/schemastery": "3.18.4"
}
```

三者的角色不同：`dependencies` 会污染 profile，`peerDependencies` 声明运行期由宿主提供，
`devDependencies` 只服务本仓库的自检脚本。`deploy.mjs --check` 的第 4 项和第 5 项分别守前两条线。
