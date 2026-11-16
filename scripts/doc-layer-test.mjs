/**
 * 分章文档层回归夹具（不启动 DSH，也不碰真实仓库）。
 *
 * 为什么要单独一份：cache-budget 只量「输出大小」，contract-test 只验「宿主接受返回值」，
 * 两者都不回答「分章文档选对了吗」。这里用临时工作区造出两种真实形态：
 *
 *   ① 单卷 99：docs/技术栈文档/NN-模块.md + 99-变更记录.md（Kirara_Server_Studio 现状）
 *   ② 多卷 99：docs/技术栈文档/NN-模块.md + 99-变更记录/00-索引 + 01…卷
 *      （Kirara_Media 重构后的目标形态）
 *
 * 断言的是检索/选章/插入计划的行为，而不是文案逐字节。
 *
 * 用法：node scripts/doc-layer-test.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginPath = new URL('../lib/impl.js', import.meta.url).href;

const failures = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg, detail) => {
  failures.push(msg);
  console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`);
};
const assert = (cond, msg, detail) => (cond ? ok(msg) : bad(msg, detail));

async function write(path, text) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text, 'utf8');
}

const root = await mkdtemp(join(tmpdir(), 'kirara-doc-layer-'));

const desktop = join(root, 'Kirara_Server_Studio');
const desktopDocs = join(desktop, 'docs', '技术栈文档');

await write(
  join(desktopDocs, '01-总览与架构.md'),
  `# 01 总览与架构

<a id="overview"></a>
## 01.1 项目结构

入口在 \`App.xaml.cs\`。

## 设计决策

这个文件刻意没有 frontmatter，用来钉住结构审计的告警。
`,
);

await write(
  join(desktopDocs, '02-认证与账户.md'),
  `---
module: 认证与账户
level: 基础层
files:
  - Services/AuthService.cs
  - Views/LoginPage.xaml(.cs)
related: [01-总览与架构.md, 99-变更记录.md]
---

# 02 认证与账户

<a id="auth"></a>
## 02.1 认证系统

登录成功后会写入刷新令牌。

<a id="account-settings"></a>
## 02.2 账号设置

昵称与头像在账号设置里修改。
`,
);

await write(
  join(desktopDocs, '99-变更记录.md'),
  `# 99 变更记录

> 只记录发生过什么；稳定结论写在模块章里。

## 2026-11-01 · 初始版本

- 建立分章文档。
`,
);

// ── ② media：多卷变更记录 + 00 索引 ─────────────────────────────────────────
const mediaDocs = join(root, 'Kirara_Media', 'app', 'docs', '技术栈文档');
await write(
  join(mediaDocs, '01-总览.md'),
  `---
module: 总览
level: 基础层
files:
  - app/src/Main.kt
---

# 01 总览

<a id="overview"></a>
## 01.1 产品定位

Android 客户端。
`,
);
await write(
  join(mediaDocs, '02-功能.md'),
  `---
module: 功能
level: 功能层
files:
  - app/src/Login.kt
---

# 02 功能

<a id="login"></a>
## 02.1 登录

登录流程。
`,
);
await write(
  join(mediaDocs, '99-变更记录', '00-索引与编号映射.md'),
  `---
module: 变更记录索引
related: [../README.md]
---

# 00 · 变更记录索引

## 分卷

| 卷 | 文件 |
| --- | --- |
| 01 | 01-第一卷.md |
`,
);
await write(
  join(mediaDocs, '99-变更记录', '01-第一卷.md'),
  `# 卷 01

<a id="ch10"></a>
## 10 · 第一卷条目

内容。
`,
);
await write(
  join(mediaDocs, '99-变更记录', '02-第二卷.md'),
  `# 卷 02

<a id="ch12"></a>
## 12 · 第二卷条目

内容。
`,
);

const mod = await import(pluginPath);
const live = new Map();
const ctx = {
  tools: {
    register(tool) {
      live.set(tool.name, tool);
      return () => live.delete(tool.name);
    },
  },
};
mod.apply(ctx, { workspaceRoot: root });

async function call(name, args) {
  const t = live.get(name);
  const value = await t.execute(args, { agent: null });
  const text = t.output.render ? t.output.render(args, value).map((b) => b.text ?? '').join('') : '';
  return { value, text };
}

try {
  console.log('=== 1. 分章集发现 + map ===');
  {
    const { value, text } = await call('kirara_docs', { mode: 'map', project: 'desktop' });
    assert(value.mode === 'map', 'mode=map 返回地图');
    const set = value.chapters?.find((g) => g.rel.endsWith('docs/技术栈文档'));
    assert(Boolean(set), '发现 docs/技术栈文档 分章集', JSON.stringify(value.chapters?.map((g) => g.rel)));
    assert(set?.chapters?.length === 2, '只把 01–89 编号文件算模块章（99 不算）', `实际 ${set?.chapters?.length}`);
    assert(set?.changelog?.volumes === 1, '单卷 99 的 volumes=1');
    assert(/01 总览与架构/.test(text) && /02 认证与账户/.test(text), '地图列出章标题');
    assert(/02\.1 认证系统 #auth/.test(text), '地图显示小节显式锚点');
  }

  console.log('\n=== 2. search：命中行带章/节/锚点 ===');
  {
    const { value } = await call('kirara_docs', { keywords: ['登录'], project: 'desktop', maxHits: 5 });
    const hit = value.hits.find((h) => h.file.endsWith('02-认证与账户.md'));
    assert(Boolean(hit), '检索到 02 章正文');
    assert(hit?.section === '02.1 认证系统', '命中行归属 02.1（不是整篇标题）', hit?.section);
    assert(hit?.anchor === 'auth', '命中行带显式锚点 #auth', hit?.anchor);
  }

  console.log('\n=== 3. section：按锚点读单节 ===');
  {
    const { value, text } = await call('kirara_docs', { mode: 'section', project: 'desktop', section: 'auth' });
    assert(value.section?.num === '02.1', 'section=auth 解析到 02.1', value.section?.num);
    assert(/登录成功后会写入刷新令牌/.test(value.section?.body ?? ''), '小节正文只含该节内容');
    assert(/## 02\.1 认证系统/.test(text), '渲染标题没有重复编号');
  }

  console.log('\n=== 4. docsync：源文件 → 章（frontmatter.files）→ 节/新增节 ===');
  {
    const existing = await call('kirara_docsync', {
      feature: '账号设置支持修改昵称',
      changes: ['Kirara_Server_Studio/Services/AuthService.cs'],
    });
    const chapter = existing.value.targets.find((t) => t.rel.endsWith('02-认证与账户.md'));
    assert(Boolean(chapter), '按 frontmatter.files 选中 02 章', JSON.stringify(existing.value.targets.map((t) => t.rel)));
    assert(chapter?.edit?.mode === 'existing' && chapter?.edit?.num === '02.2', '命中既有小节 02.2', JSON.stringify(chapter?.edit));
    assert(existing.value.targets.some((t) => t.role === 'changelog'), '带 99 变更记录目标');
    assert(/frontmatter\.files/.test(existing.text), '提示补 frontmatter.files');

    const add = await call('kirara_docsync', {
      feature: '新增扫码登录',
      changes: ['Kirara_Server_Studio/Services/AuthService.cs'],
    });
    const addChapter = add.value.targets.find((t) => t.rel.endsWith('02-认证与账户.md'));
    assert(addChapter?.edit?.mode === 'new' && addChapter?.edit?.num === '02.3', '无既有小节时给 02.3 新增计划', JSON.stringify(addChapter?.edit));
    assert(/<a id="/.test(addChapter?.edit?.action ?? ''), '新增计划的 action 带显式 anchor');
    assert(addChapter?.addFiles?.length === 0, '源文件已登记进 frontmatter 时不重复提示', JSON.stringify(addChapter?.addFiles));

    const fix = await call('kirara_docsync', {
      feature: '修复登录失败',
      changes: ['Kirara_Server_Studio/Services/AuthService.cs'],
    });
    const fixChapter = fix.value.targets.find((t) => t.rel.endsWith('02-认证与账户.md'));
    assert(fixChapter?.edit?.mode === 'chapter', 'BUG 修复不新增以问题命名的小节', JSON.stringify(fixChapter?.edit));

    const direct = await call('kirara_docsync', {
      feature: '同步一下文档',
      changes: ['Kirara_Server_Studio/docs/技术栈文档/01-总览与架构.md'],
    });
    assert(
      direct.value.targets.some((t) => t.rel.endsWith('01-总览与架构.md')),
      '纯文档变更直接点名的章节优先于关键词兜底',
      JSON.stringify(direct.value.targets.map((t) => t.rel)),
    );
  }

  console.log('\n=== 5. 多卷 99：最新卷 + 00 索引 + 历史编号递增 ===');
  {
    const map = await call('kirara_docs', { mode: 'map', project: 'media' });
    const set = map.value.chapters?.find((g) => !g.loose && g.rel.endsWith('技术栈文档'));
    assert(Boolean(set), 'media 分章集被发现');
    assert(set?.changelog?.volumes === 2, '00 索引不算卷 ⇒ 01/02 两卷 volumes=2', JSON.stringify(set?.changelog));
    assert(/最新卷 02/.test(map.text), '地图显示最新卷');

    const sync = await call('kirara_docsync', {
      feature: '新增播放器手势',
      changes: ['Kirara_Media/app/src/Login.kt'],
    });
    const volume = sync.value.targets.find((t) => t.role === 'changelog');
    assert(Boolean(volume), '带变更记录目标');
    assert(volume?.edit?.mode === 'append', '多卷时追加到最新卷末尾（不是插到卷首）', volume?.edit?.mode);
    assert(/^## 13 · /.test(volume?.edit?.entry ?? ''), '历史编号取最大 +1（12 → 13）', volume?.edit?.entry);
    assert(/00-索引与编号映射\.md/.test(volume?.edit?.action ?? ''), '提示同步 00 索引');
  }

  console.log('\n=== 6. 结构审计：缺 frontmatter / 未编号小节 / 断链 ===');
  {
    const { value } = await call('kirara_docs', { mode: 'map', project: 'desktop' });
    const warnings = value.warnings ?? [];
    assert(warnings.some((w) => /未编号/.test(w)), '报告未编号小节（01 的「设计决策」）', warnings.join(' | '));
    assert(warnings.some((w) => /缺 frontmatter/.test(w)), '报告缺 frontmatter 的模块章', warnings.join(' | '));
    assert(!warnings.some((w) => /99-变更记录/.test(w)), '99 变更记录不因缺 frontmatter 被误报', warnings.join(' | '));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('');
if (failures.length) {
  console.log(`❌ 分章文档层回归未通过：${failures.length} 项`);
  process.exit(1);
}
console.log('✅ 分章文档层回归通过');
