# 插件包格式规范 (Plugin Package Spec) — 草案

状态:**草案,待评审,服务端实现中**(作者侧模板与本地打包工具已提供,见第 8.1 节) · 取代对象:媒体插件开发规范第 10.1 节"包格式"(单 `.mjs` + `manifest` 表单字段) · 依据:MuseCanvas 主仓库 `c6616dd` 的上传与加载实现

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
- **macOS 归档元数据静默忽略**:路径中任意一段为 `__MACOSX` 的条目(任意深度,包括包裹目录内),以及任意深度、文件名恰为 `.DS_Store` 的文件(均大小写敏感,与 Finder 写法一致)。它们先照常过第 4 节第 3 步的路径安全检查(所以 `__MACOSX/../x` 仍被拒绝),仍计入条目数、解压总量(按声明值)与 zip 大小上限;但不解压、不进文件清单、不产生 finding,判断"是否恰好一层包裹目录"时也先把它们排除。参考打包工具从不产出这类文件。
- 目录条目(以 `/` 结尾、大小为 0)允许存在,计入条目数;带数据的目录条目拒绝。

### 2.1 允许的文件

| 类型 | 扩展名 | 数量 | 单文件上限 |
|------|--------|------|-----------|
| 入口 bundle | `.mjs` | **恰好 1 个**,且必须是 `package.entry` | 5 MiB(沿用 `PLUGIN_ARTIFACT_MAX_BYTES`) |
| manifest | `manifest.json` | 恰好 1 个 | 256 KiB |
| 文档 | `.md`、`.txt`,以及无扩展名的 `LICENSE` | 不限 | 256 KiB |
| 图标 | `.png`、`.webp` | 最多 1 个(须被 `package.icon` 引用) | 256 KiB,边长 ≤ 512 px |

其他一切文件(`.js` / `.cjs` / 第二个 `.mjs` / `.wasm` / `.node` / `.json`(manifest 之外) / `.svg` / `.html` / 嵌套 `.zip` 等)均拒绝。`.svg` 不允许,因为它可以携带脚本,而管理台会直接渲染图标。

- 扩展名比较不区分大小写;无扩展名的 `LICENSE` 须恰为大写 `LICENSE`。
- 文档可以位于任意深度(如 `docs/usage.md`),都要通过 256 KiB 上限与第 4 节第 7 步的文本校验。管理台展示的文档只取以下几份:
  - README:`package.readme` 指定的文件(任意深度,须是包内的文档文件);未指定时取剥层后根目录的 `README.md`(文件名不区分大小写);
  - CHANGELOG:根目录的 `CHANGELOG.md` 或 `CHANGELOG.txt`(不区分大小写);
  - LICENSE:根目录的 `LICENSE`、`LICENSE.md` 或 `LICENSE.txt`(不区分大小写)。

  同一类有多个候选时按路径字节序取第一个。其余 `.md` / `.txt`(包括更深路径下的文档)**允许并出现在包内文件清单(`package_files`)里,但不存入文档列、不在管理台展示**。
- 图标只接受静态图像:APNG(含 `acTL` 块)与动画 WebP 拒绝;服务端还会完整解码像素,并要求解码尺寸与文件头一致。

### 2.2 包级限制

| 项 | 上限 |
|----|------|
| zip 文件本身 | 6 MiB |
| 解压后总大小 | 8 MiB |
| 条目数 | 32(含目录条目与被忽略的 macOS 元数据) |
| 单条目压缩比 | ≤ 100:1(防 zip 炸弹;按 central directory 声明值预检,即 `uncompressed > 100 × max(compressed, 1)` 拒绝;解压时按实际字节流再检,超过声明大小即拒绝) |
| 路径长度 | ≤ 200 字节,UTF-8 |

压缩比上限可能误伤高度重复的文本(如大段重复的表格或填充内容,deflate 后比例可超过 100:1)。参考打包工具(本仓库 `tools/`)遇到压缩后比例超过 100:1、或压缩后不变小的文件,改用 `stored`(不压缩)写入,比例即为 1:1;自行打包的作者遇到 `PLUGIN_PACKAGE_BOMB` 时可同样处理。

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

`package` 块只认上面 7 个键,出现其他键(例如 `minHostVersion`)即拒绝(`PLUGIN_PACKAGE_INVALID`);缺少 `package` 块或 `entry` 记为 `PLUGIN_PACKAGE_ENTRY_MISSING`;`package.icon` 指向 `.svg` 记为 `PLUGIN_PACKAGE_FORBIDDEN_FILE`。`homepage` 须为不含用户名 / 密码的 https URL。

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
3. **路径安全**:拒绝绝对路径、`..` 与 `.` 段、空段、反斜杠、路径中任何位置的 `:`(盘符 `C:` 与 NTFS 备用数据流)、NUL 与控制字符;条目名一律按严格 UTF-8 解码(不看 general purpose flag 的 UTF-8 位),不是合法 UTF-8 的名称(如 CP437 / GBK 编码的旧压缩工具产物)作为不安全路径拒绝;拒绝 Unix / macOS 主机写入的符号链接与设备文件(按 external attributes 判断);路径在 NFC 规范化、转小写后不得重名(防 Windows / macOS 上大小写或 Unicode 等价的覆盖),也不得嵌套在一个同名文件之下。此步对所有条目执行,之后才剔除第 2 节所述的 macOS 元数据。
4. **清单约束**:第 2.1 / 2.2 节的白名单、数量、单文件与总量上限、压缩比。
5. **manifest**:`manifest.json` 须为 UTF-8 JSON(开头的 BOM 会被去掉);`package` 块合法(第 3 节,未知键拒绝);其余部分跑现有 `validatePluginManifest`。
6. **入口**:`package.entry` 存在且是包内唯一的 `.mjs`;对其跑现有 `scanPluginSource`(规则不变)。
7. **资源**:图标解码校验格式与尺寸,拒绝动画图标;所有文档(`.md` / `.txt` / `LICENSE`,不只是展示的几份)须为合法 UTF-8 且不含 NUL(数据库 `text` 列无法存 NUL),开头的 BOM 会被去掉。
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
| `PLUGIN_PACKAGE_UNAVAILABLE` | HTTP 503:下载原始 zip(`GET /admin/plugins/:id/package`)或图标(`GET /admin/plugins/:id/icon`)时对象存储读取失败,或 zip 与 `package_sha256` 不符 |
| `PLUGIN_UPLOAD_LEGACY_FORMAT` | **警告**(`severity: warn`,不阻断):使用旧的 `manifest` + `file` 两字段上传;只出现在响应里,不写入扫描报告 |

包级校验失败时,服务端 findings 的 `rule` 即上表错误码;扫描与 manifest 校验沿用 `PLUGIN_SCAN_FAILED` / `INVALID_PLUGIN_MANIFEST` 及其各自的 rule。

---

## 5. 存储与加载

**原则:zip 只在 API 进程里解析;worker 永远不解析 zip。** worker 是唯一执行插件代码的进程,把解压这块攻击面留在 API,worker 保持现有的"取字节 → 校验 sha256 → 扫描 → import"路径。

### 5.1 API 写入

| 对象 | 存储键 | 说明 |
|------|--------|------|
| 原始 zip | `plugin-packages/<id>/<version>/<zip_sha256>.zip` | 归档与重新下载,不参与运行 |
| 入口 bundle | `plugin-packages/<id>/<version>/<entry_sha256>.mjs` | **与现有键格式相同**,worker 照旧读取 |
| 图标 | `plugin-packages/<id>/<version>/icon-<sha256>.<ext>` | 管理台展示 |

第 2.1 节选出的 README / CHANGELOG / LICENSE 文本直接存进数据库(各 ≤ 256 KiB);其他文档只出现在 `package_files` 清单中。

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

文档文本**不随列表返回**:插件列表 DTO 只带 `docs: { readme, changelog, licenseText }` 三个布尔标志(以及 `hasIcon`、`packageFiles`、`packageMeta`、`packageDigest`),文本按需从 `GET /admin/plugins/:id/docs` 获取,响应为 `{ readme, changelog, licenseText }`(字符串或 `null`;旧格式行一律为 `null`)。文档是作者提供的内容,客户端只能按纯文本渲染,不得当作 HTML。

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

### 8.1 模板与打包工具

本仓库提供:

- **插件模板** [`template/`](../template/README.md):一个完整的异步视频插件(占位供应商 `api.example-video.example`),`src/index.ts` 直接 `import` `manifest.json` 并去掉 `package` 块作为 `plugin.manifest`,由 esbuild 内联,天然满足第 3.1 节的一致性要求。宿主类型以 `import type` 引用本地副本 `src/host-types.ts`(主仓库包未发布到 npm),错误以 `message = code` 且携带 `diagnostic` 的 `Error` 抛出(worker `classifySubmitError` 识别的上传插件形状)。
- **打包工具** `tools/cli.mjs`(仓库根目录执行):

```bash
corepack pnpm pack:plugin <插件目录> [--out <file.zip>]   # 构建 + 本地校验 + 写出 zip,打印 sha256
corepack pnpm check:plugin <file.zip> [--no-import]       # 校验已有 zip
corepack pnpm build:plugin <插件目录>                      # 只构建 bundle
```

  - 构建:esbuild `format: esm`、`platform: neutral`、`bundle: true`、无 external、去掉注释;构建后检查 bundle 不含任何 import,并把 esbuild 末尾的 `export { x as default }` 改写为字面量 `export default x`(`scanPluginSource` 只识别后者,否则报 `NO_DEFAULT_EXPORT` 警告)。
  - 打包:只收 `manifest.json`、入口、`README.md` / `CHANGELOG.md` / `LICENSE*` 与 `package.icon`,平铺在 zip 根目录;`manifest.json` 在前,其余按路径字节序;时间戳固定为 1980-01-01 00:00,外部属性固定;压缩后比例超过 100:1 或不变小的文件改用 `stored`;从不产出 `__MACOSX/` 或 `.DS_Store`。同样的输入得到同样的 sha256。
  - 校验:按第 4 节第 1–8 步顺序执行(第 8 步只检查内置 `id` / `providerId` 的静态快照,版本不可变需服务端判断),再导入 bundle,按第 5.3 节比较 `validatePluginManifest` 规范化结果,并检查接口必需方法。`--no-import` 跳过导入(不执行 bundle 代码)。
  - 过渡期:同时写出 `dist/manifest.legacy.json`(即 `manifest.json` 去掉 `package`),可配合 `dist/plugin.mjs` 走旧的两字段上传。

> 本地校验是服务端规则的**便利副本**,以 MuseCanvas 为准:`tools/lib/plugin-scan.mjs` 移植自主仓库 `packages/providers/src/core/plugin-scan.ts`(同步至 `c6616dd`),`tools/lib/check-package.mjs` 对应本节规范与主仓库 `core/plugin-package.ts`。模型 `capabilities` 本地只做结构检查,完整的 `validateModelCapabilities` 只在服务端运行。本地通过不保证服务端接受;规则变更时同步更新这两个文件。

---

## 9. 待决问题

1. **旧格式过渡期多长?** 建议一个小版本周期后移除 `manifest` + `file` 上传方式;已安装的旧插件继续可用。
2. **是否要求包签名?** 本草案只靠 sha256 + 版本不可变。若要第三方分发,需要发布者密钥与签名校验,建议另立规范。
3. **上限数值**(6 MiB zip / 8 MiB 解压 / 32 条目 / 图标 256 KiB)是否合适?
4. **是否允许纯数据文件**(如模型参数表 `.json`)随包分发、由入口读取?本草案不允许:入口无文件系统访问,数据应内联进 bundle。
5. **宿主版本约束**:是否需要 `package.minHostVersion`?主仓库目前没有对外的宿主版本号,暂不引入。
