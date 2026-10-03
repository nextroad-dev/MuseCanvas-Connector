# 插件包格式规范 (Plugin Package Spec) — 草案

状态:**草案,待评审,未实现** · 取代对象:媒体插件开发规范第 10.1 节"包格式"(单 `.mjs` + `manifest` 表单字段) · 依据:MuseCanvas 主仓库 `c6616dd` 的上传与加载实现

---

## 1. 背景与目标

现状(见 [媒体插件开发规范](./video-plugin-spec.md) 第 10 节):上传插件由两个 multipart 字段组成 —— `manifest`(粘贴的 JSON 文本)和 `file`(单个 `.mjs`)。问题:

- manifest 与代码分开传递,二者只在 worker 加载时才比对 `kind` / `id` / `version`,其余字段可能不一致;
- 插件作者无法随包交付 README、图标、许可证、变更记录,管理台只能展示 manifest 里的几行文字;
- 分发时是"一段 JSON + 一个文件",不是一个可签名、可归档、可复现的整体。

目标:插件以**单个 `.zip` 包**分发与上传,包内自带 manifest、入口 bundle 和展示资源;安全模型(零运行时 import、源码扫描、主机白名单、版本不可变)**保持不变**。

### 1.1 非目标

- **不支持多模块代码。** zip 不是放开"零运行时 import"的手段:包内只能有一个可执行文件(入口 `.mjs`),依赖必须打包进这一个文件。
- 不引入包签名与发布者身份(列为后续工作,见第 9 节)。
- 不改变插件运行时接口(`MediaProviderPlugin` / `LanguageProviderPlugin`)。

---

## 2. 包结构

```text
<任意文件名>.zip
├── manifest.json          必需  插件 manifest + package 块(第 3 节)
├── plugin.mjs             必需  入口 bundle;路径由 manifest.package.entry 指定
├── README.md              可选  管理台详情页展示(渲染时消毒)
├── CHANGELOG.md           可选
├── LICENSE                可选  也可为 LICENSE.md / LICENSE.txt
└── assets/
    └── icon.png           可选  由 manifest.package.icon 指定
```

- 文件可以直接位于 zip 根目录,也可以统一包在**恰好一层**顶级目录里(如 `my-plugin-1.2.0/manifest.json`,常见于直接压缩文件夹);宿主剥掉这一层。两层及以上、或根目录与顶级目录混放,一律拒绝。
- `manifest.json` 必须位于(剥层后的)根目录,文件名大小写敏感。

### 2.1 允许的文件

| 类型 | 扩展名 | 数量 | 单文件上限 |
|------|--------|------|-----------|
| 入口 bundle | `.mjs` | **恰好 1 个**,且必须是 `package.entry` | 5 MiB(沿用 `PLUGIN_ARTIFACT_MAX_BYTES`) |
| manifest | `manifest.json` | 恰好 1 个 | 256 KiB |
| 文档 | `.md`、`.txt`,以及无扩展名的 `LICENSE` | 不限 | 256 KiB |
| 图标 | `.png`、`.webp` | 最多 1 个(须被 `package.icon` 引用) | 256 KiB,边长 ≤ 512 px |

其他一切文件(`.js` / `.cjs` / 第二个 `.mjs` / `.wasm` / `.node` / `.json`(manifest 之外) / `.svg` / `.html` / 嵌套 `.zip` 等)均拒绝。`.svg` 不允许,因为它可以携带脚本,而管理台会直接渲染图标。

### 2.2 包级限制

| 项 | 上限 |
|----|------|
| zip 文件本身 | 6 MiB |
| 解压后总大小 | 8 MiB |
| 条目数 | 32 |
| 单条目压缩比 | ≤ 100:1(防 zip 炸弹;按 central directory 声明值预检,解压时按实际字节流再检) |
| 路径长度 | ≤ 200 字节,UTF-8 |

---

## 3. manifest.json

`manifest.json` 是**唯一**的 manifest 来源:即现有插件 manifest(媒体插件开发规范第 2.2、2.5、2.6 节)外加一个 `package` 块。上传接口不再接受单独的 `manifest` 表单字段。

```jsonc
{
  "kind": "media",
  "id": "acme-video",
  "version": "1.2.0",
  "displayName": "Acme Video",
  "modalities": ["video"],
  "allowedHosts": ["api.acme.example"],
  "credentialSchemas": ["legacy-api-key-v1"],
  "credential": { "providerId": "acme", "schemaId": "legacy-api-key-v1", "secret": { "format": "text", "label": "Acme API Key" }, "baseUrl": { "default": "https://api.acme.example", "policy": "fixed" } },
  "models": [ { "id": "acme-v2", "modalities": ["video"], "capabilities": { /* ... */ } } ],

  "package": {
    "format": 1,                     // 必需,包格式版本;宿主拒绝不认识的值
    "entry": "plugin.mjs",           // 必需,入口相对路径,扩展名必须是 .mjs
    "icon": "assets/icon.png",       // 可选
    "readme": "README.md",           // 可选,缺省时自动取根目录 README.md
    "license": "MIT",                // 可选,SPDX 标识
    "author": "Acme Inc.",           // 可选,≤ 200 字符
    "homepage": "https://acme.example/musecanvas"  // 可选,必须 https
  }
}
```

### 3.1 manifest 与 bundle 的一致性

bundle 的 `export default` 对象仍须带 `manifest`(运行时接口不变)。加载时 worker 要求:

- `validatePluginManifest(bundle.manifest)` 与 `validatePluginManifest(manifest.json 去掉 package 块)` 的**规范化结果深度相等**,而不只是 `kind` / `id` / `version` 相同。

这是相对现状的收紧:管理台展示、凭据模板、模型能力都取自 `manifest.json`,运行时取自 bundle;两者必须是同一份声明。

> 备选方案:bundle 不再携带 manifest,由宿主注入。改动运行时接口,本草案不采用。

---

## 4. 安全校验

API 侧在**写入存储之前**按以下顺序校验,任一失败即拒绝安装(HTTP 422,返回 findings,沿用现有 `rejected()` 信封):

1. **大小预检**:zip 字节数 ≤ 6 MiB(在读取任何条目之前)。
2. **结构解析**:只读 central directory;拒绝加密条目、zip64、多卷、非 `stored` / `deflate` 的压缩方法、central directory 与 local header 不一致的条目。
3. **路径安全**:拒绝绝对路径、`..` 段、反斜杠、盘符(`C:`)、NUL 与控制字符;拒绝 Unix 符号链接与设备文件(按 external attributes 判断);路径在 NFC 规范化、转小写后不得重名(防 Windows / macOS 上大小写或 Unicode 等价的覆盖)。
4. **清单约束**:第 2.1 / 2.2 节的白名单、数量、单文件与总量上限、压缩比。
5. **manifest**:`manifest.json` 须为 UTF-8 JSON;`package` 块合法;其余部分跑现有 `validatePluginManifest`。
6. **入口**:`package.entry` 存在且是包内唯一的 `.mjs`;对其跑现有 `scanPluginSource`(规则不变)。
7. **资源**:图标解码校验格式与尺寸;README / CHANGELOG / LICENSE 须为合法 UTF-8。
8. **身份**:沿用 `PLUGIN_ID_RESERVED`、`PROVIDER_ID_RESERVED`、版本不可变检查。

解压全程在内存中按条目流式进行,每个条目都设字节上限,**绝不写到文件系统的解压路径上**。

### 4.1 新增错误码

| code | 场景 |
|------|------|
| `PLUGIN_PACKAGE_TOO_LARGE` | zip、解压总量或单文件超限 |
| `PLUGIN_PACKAGE_INVALID` | 不是合法 zip、加密、zip64、不支持的压缩方法、目录层级不合规 |
| `PLUGIN_PACKAGE_UNSAFE_PATH` | 路径穿越、绝对路径、符号链接、重名 |
| `PLUGIN_PACKAGE_FORBIDDEN_FILE` | 白名单外的文件类型、多个 `.mjs`、未被引用的图标 |
| `PLUGIN_PACKAGE_ENTRY_MISSING` | `package.entry` 缺失或不存在 |
| `PLUGIN_PACKAGE_BOMB` | 压缩比超限 |
| `PLUGIN_MANIFEST_MISMATCH` | (worker)bundle manifest 与 `manifest.json` 规范化后不相等 |

---

## 5. 存储与加载

**原则:zip 只在 API 进程里解析;worker 永远不解析 zip。** worker 是唯一执行插件代码的进程,把解压这块攻击面留在 API,worker 保持现有的"取字节 → 校验 sha256 → 扫描 → import"路径。

### 5.1 API 写入

| 对象 | 存储键 | 说明 |
|------|--------|------|
| 原始 zip | `plugin-packages/<id>/<version>/<zip_sha256>.zip` | 归档与重新下载,不参与运行 |
| 入口 bundle | `plugin-packages/<id>/<version>/<entry_sha256>.mjs` | **与现有键格式相同**,worker 照旧读取 |
| 图标 | `plugin-packages/<id>/<version>/icon-<sha256>.<ext>` | 管理台展示 |

README / CHANGELOG / LICENSE 文本直接存进数据库(各 ≤ 256 KiB)。

### 5.2 数据库

`provider_plugins` 新增列(新的顺序迁移):

| 列 | 类型 | 说明 |
|----|------|------|
| `package_format` | `text NOT NULL DEFAULT 'mjs'` | `'mjs'`(旧上传) / `'zip-v1'` |
| `package_object_key` | `text` | 原始 zip 的键 |
| `package_sha256` | `text` | 原始 zip 的 sha256 |
| `package_files` | `jsonb NOT NULL DEFAULT '[]'` | `[{ path, sizeBytes, sha256 }]` |
| `package_meta` | `jsonb NOT NULL DEFAULT '{}'` | `package` 块(author、license、homepage、icon 键) |
| `readme` / `changelog` / `license_text` | `text` | 文档文本 |

`object_key` / `artifact_sha256` / `artifact_size_bytes` 的语义**不变**,仍指入口 bundle,因此 worker 的完整性校验不需要改。`(plugin_id, plugin_version)` 仍然一次写入。

### 5.3 worker 改动

只多一步:import 之后,把 bundle 的 manifest 与数据库中的 `manifest`(即 `manifest.json` 规范化结果)做深度比较,不等则 `PLUGIN_MANIFEST_MISMATCH`、状态 `failed`。旧格式(`package_format = 'mjs'`)的行保持现有的 identity 比对。

---

## 6. 上传接口

`POST /admin/plugins`(及 validate 预检端点):

- `multipart/form-data`,**只有一个字段 `package`**,值为 `.zip` 文件;
- 响应结构不变,`findings` 中的文件级问题带 `path` 字段指向包内文件。

过渡期:旧的 `manifest` + `file` 两字段形式继续接受并记为 `package_format = 'mjs'`,同时在响应中返回 `PLUGIN_UPLOAD_LEGACY_FORMAT` 警告;过渡期结束后移除(时长见第 9 节)。

管理台上传对话框:改为选择单个 `.zip`;已安装插件详情页展示图标、README、作者/许可证/主页、包内文件清单与 sha256,以及下载原始 zip 的入口。

---

## 7. 主仓库改动范围

| 位置 | 改动 |
|------|------|
| `packages/providers/src/core/plugin-package.ts`(新) | 纯函数:给定 zip 的条目元数据和读取器,完成第 4 节第 2–7 步校验,返回规范化包描述或 findings。不依赖 node 内建,便于 API 与单测共用 |
| `apps/api/src/modules/admin/plugins.ts` | `readPluginPackage` 改读 `package` 字段;解压、调用校验、按第 5.1 节写存储与数据库;保留旧格式分支 |
| `apps/worker/src/plugins/loader.ts` | 第 5.3 节的 manifest 深度比较 |
| `packages/database` 迁移 | 第 5.2 节新增列 |
| `apps/web-next` 插件上传对话框、已安装插件详情 | 第 6 节 UI |
| 依赖 | zip 解析库,建议 `fflate`(纯 JS、无依赖、同时可在浏览器中做上传前预检) |

### 7.1 测试

- `plugin-package.test.ts`:合法包(平铺 / 单层目录);每一条拒绝规则各一个夹具(路径穿越、符号链接、大小写重名、加密条目、zip64、第二个 `.mjs`、`.svg` 图标、压缩比超限、总量超限、缺少 entry、两层目录);
- API:旧格式与新格式上传、存储键、数据库列;
- worker:manifest 深度一致与不一致;旧格式行仍按 identity 比对;
- 集成:`tests/integration/` 下新增"打包 → 上传 → 加载 → 调用"全 mock 用例。

---

## 8. 对作者的影响

1. 和现在一样,把插件构建成单个自包含的 ESM bundle(零运行时 import)。
2. 写 `manifest.json`:现有 manifest 加上 `package` 块;bundle 里的 `manifest` 必须与之一致(建议构建时直接从 `manifest.json` 导入并内联)。
3. 按第 2 节目录结构打成 zip 上传。

本仓库后续可提供插件模板与打包脚本(构建 bundle、内联 manifest、本地跑第 4 节的校验、产出 zip)。

---

## 9. 待决问题

1. **旧格式过渡期多长?** 建议一个小版本周期后移除 `manifest` + `file` 上传方式;已安装的旧插件继续可用。
2. **是否要求包签名?** 本草案只靠 sha256 + 版本不可变。若要第三方分发,需要发布者密钥与签名校验,建议另立规范。
3. **上限数值**(6 MiB zip / 8 MiB 解压 / 32 条目 / 图标 256 KiB)是否合适?
4. **是否允许纯数据文件**(如模型参数表 `.json`)随包分发、由入口读取?本草案不允许:入口无文件系统访问,数据应内联进 bundle。
5. **宿主版本约束**:是否需要 `package.minHostVersion`?主仓库目前没有对外的宿主版本号,暂不引入。
