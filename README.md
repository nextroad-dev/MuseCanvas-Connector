# MuseCanvas Connector

**MuseCanvas 的媒体 provider 插件与连接器规范仓库**

MuseCanvas 的图像与视频生成能力走「**media provider 内核 + 插件**」架构：内核负责注册表、安全 HTTP、凭据契约、错误归一化与输出读取，插件只描述供应商协议与模型能力，全部由 `apps/worker` 消费。插件既可以是随主仓库发布的内置静态插件，也可以是管理员上传、由 worker 动态加载的 `.mjs` 插件包。本仓库承载这套插件体系的工程规范，并作为独立 connector / 插件实现的协作入口。

## 仓库状态

当前仓库包含规范文档、一个可直接打包的插件模板（`template/`）与插件打包工具（`tools/`），规范内容同步至主仓库 `c6616dd`（2026-10-02）。插件内核与内置插件源码仍在主仓库 [nextroad-dev/MuseCanvas](https://github.com/nextroad-dev/MuseCanvas)：

| 路径（主仓库） | 内容 |
| --- | --- |
| `packages/providers/src/core/` | provider 内核：registry、SafeHttpClient、主机白名单语法、凭据契约、上传插件扫描、错误归一化、输出读取、输入图校验 |
| `packages/providers/src/plugins/` | 内置静态插件（openai-image、seedream-image、seedance-video、veo-video、builtin-language） |
| `packages/contracts/src/media-parameters.ts` | 模型能力 / 参数描述符契约（浏览器、API、插件共用） |
| `apps/worker/src/jobs/` | 插件消费端：任务状态机与输出摄取 |
| `apps/worker/src/plugins/` | 上传插件加载器与可用性门禁 |
| `tests/integration/*.test.ts` | 契约门禁测试 |

## 仓库内容

| 路径 | 内容 |
| --- | --- |
| [`wiki/README.md`](./wiki/README.md) | 规范索引与适用范围 |
| [`wiki/video-plugin-spec.md`](./wiki/video-plugin-spec.md) | 媒体插件开发规范：内核契约、凭据契约、模型能力声明、生命周期与状态机、输出契约、安全红线、错误模型、测试门禁、上传插件 |
| [`wiki/plugin-package-spec.md`](./wiki/plugin-package-spec.md) | 插件包格式规范（草案）：zip 包结构、`manifest.json` 的 `package` 块、安全校验 |
| [`template/`](./template/README.md) | 插件模板：异步视频插件示例（占位供应商），manifest 单一来源，附生命周期单测 |
| `tools/` | 打包工具：esbuild 构建自包含 ESM bundle、本地跑包校验、产出可复现的 zip |

> 规范本身即门禁依据：违反契约测试的 PR 不予合入。

## 快速开始：构建 → 打包 → 上传

需要 Node.js ≥ 22 与 pnpm（经 `corepack` 使用即可）。

```bash
corepack pnpm install
corepack pnpm typecheck                                   # 模板类型检查
corepack pnpm test                                        # 工具与模板的单测
corepack pnpm pack:plugin template                        # 构建 + 本地校验 + 写出 zip，打印 sha256
corepack pnpm check:plugin template/dist/example-video-0.1.0.zip   # 校验已有 zip
```

`pack:plugin <目录>` 依次完成：

1. 以 `src/index.ts` 为入口，用 esbuild 打成**单个自包含 ESM 文件**（`format: esm`、`platform: neutral`、全部内联、无 external），文件名取 `manifest.json` 的 `package.entry`；
2. 收集 `manifest.json`、bundle、`README.md` / `CHANGELOG.md` / `LICENSE` 与 `package.icon`（只收这些，不做通配）；
3. 按固定顺序、固定时间戳写 zip（同样的输入得到同样的 sha256）；
4. 对 zip 跑一遍与插件包格式规范第 4 节对应的本地校验，并导入 bundle 比对 `bundle.manifest` 与 `manifest.json`（去掉 `package`）；任一错误则不写 zip。

产物在 `<目录>/dist/`：`<id>-<version>.zip`、入口 bundle，以及过渡期用的 `manifest.legacy.json`。`check:plugin <zip>` 对任意 zip 跑同一套校验；对不信任的 zip 加 `--no-import`（跳过导入执行 bundle，也就跳过 manifest 比对）。

上传：在管理台“插件”页上传 zip。zip 上传仍在主仓库实现中（规范为草案），在此之前用旧格式上传：`manifest` 字段粘贴 `dist/manifest.legacy.json` 的内容，`file` 选择 `dist/plugin.mjs`。

> 本地校验是 MuseCanvas 服务端规则的**便利副本**（`tools/lib/plugin-scan.mjs` 移植自主仓库 `packages/providers/src/core/plugin-scan.ts`，`tools/lib/check-package.mjs` 对应规范第 4 节与主仓库 `core/plugin-package.ts`），以 MuseCanvas 为准：本地通过不保证服务端接受。模型 `capabilities` 本地只做结构检查，完整校验（`validateModelCapabilities`）只在服务端进行。

## 架构速览

```text
apps/worker
  ├─ plugins/loader（上传插件：sha256 校验 → 扫描 → manifest 校验 → 注册）
  └─ jobs（任务状态机 / 输出摄取）
       └─ ProviderRegistry（按 id@version 精确解析）
            └─ MediaProviderPlugin（内置静态插件 / 上传插件）
                 └─ ExecutionContext.http ──▶ SafeHttpClient（唯一网络出口）
```

插件**不允许**自行发起网络请求：所有出站流量都必须经过注入的 `ExecutionContext`。

## 核心契约

- **插件接口** `MediaProviderPlugin`：`validateConfig` / `validateRequest` 必须实现；`submit` 是入口；异步任务必须实现 `poll` 与 `cancel`；`openOutput` 负责输出字节获取；`probe` 可选，用于凭据连通性测试（只在 worker 中执行）。
- **Manifest 硬要求**：`kind: 'media'`，按 `id@version` 精确注册；`modalities` 声明 `image` / `video`；`allowedHosts` 为白名单语义（精确主机、`*.` 子域通配、内置插件另可用 `*-` 单 label 通配）；`credential` 声明消费的凭据；`models` 非空，每个模型以 `capabilities` 声明参数契约。
- **凭据契约** `manifest.credential`：凭据属于供应商账号（`providerId` + schema），不绑定插件版本，同账号插件共用；`baseUrl.policy` 取 `fixed` / `allowlisted` / `any-https`（后者仅内置插件）。
- **模型能力声明**：manifest 是参数的唯一事实来源，浏览器、API 与插件适配器共用一个校验器；未声明契约的模型在 API 边界被拒绝。契约参数经 `MediaRequest.parameters` 传入，不走 `extra`。
- **唯一网络出口** `SafeHttpClient`：仅允许 `https:`；目标主机必须命中 `allowedHosts`；重定向逐跳重新校验且上限 5 跳；响应体按 `maxBytes` 有界读取；所有出站调用必须显式传 `timeoutMs`。
- **凭据**：只从 `ProviderConfig` / 凭据对象读取，禁止读取 `process.env` 或环境默认凭据。
- **输出契约**：`OutputDescriptor` 的 `url` 与 `b64Json` 互斥且必有其一，`index` 稠密递增，`url` 必须是 `https:`（`gs://` 等定位符必须在 `poll` 内映射为 HTTPS）。
- **opaqueState 卫生**：只允许 JSON 安全标识符（taskId / operationName / 模型与参数回显），禁止 token、密钥、URL 与签名参数。

## 生命周期

```text
submit → waiting / submission_unknown / succeeded（同步插件） / failed
poll   → waiting（携带 retryAfterMs） / succeeded（outputs） / failed / canceled
cancel → canceled / waiting（仍在收尾）
```

异步远端任务的**瞬时错误绝不映射为 `failed`**：429 / 5xx / 传输错误走 `waiting` 或 `submission_unknown`，只有确定性 4xx、内容安全过滤、空结果与远端任务终态失败才返回 `failed`。

## 内置插件（主仓库现状）

| 插件 | 活动版本 | 模态 | 参考点 |
| --- | --- | --- | --- |
| `openai-image` | `1.1.0`（保留 `1.0.0`） | image | 同步生命周期、输入图与输出解码契约 |
| `seedream-image` | `1.1.0`（保留 `1.0.0`） | image | 同步生命周期、Ark 协议 |
| `seedance-video` | `1.0.0` | video | 异步轮询、幂等键 `x-client-request-id` |
| `veo-video` | `1.0.0` | video | 异步轮询、服务账号 JWT 铸造、GCS→HTTPS 映射、`imageRoles` 首尾帧放置 |
| `openai-language` / `anthropic-language` | `1.0.0` | language | 原生语言协议，`any-https` 端点策略 |

写异步视频插件时优先参考 `veo-video`，其次 `seedance-video`；同步图像参考 `openai-image` / `seedream-image`。`seedream-image` 与 `seedance-video` 同属 `volcengine` 账号，共用一份 Ark 凭据。

## 上传插件

运维设置 `ALLOW_PLUGIN_UPLOAD=true` 后，管理员可在管理台上传第三方插件包（当前为 `manifest` JSON + 单个 `.mjs`，≤ 5 MiB；计划改为单个 zip 包，见[插件包格式规范（草案）](./wiki/plugin-package-spec.md)）。要点：

- bundle 必须自包含、**零运行时 import**（只允许 `import type`），以 `export default` 导出插件对象；源码扫描拒绝 `fetch`、`process.*`、`require`、`eval`、Node 内建模块与顶层 `await`。
- `allowedHosts` 只能是精确主机或 `*.` 前缀，禁止 IP 与私网地址；`credential.baseUrl.policy` 不得为 `any-https`。
- 不得占用内置插件的 `id@version` 或 `providerId`（`openai` / `anthropic` / `volcengine` / `google`）。
- `(plugin_id, plugin_version)` 一次写入、不可复用；修复只能升版本重传。

详见规范第 10 节；从模板起步见上文“快速开始”。

## 安全红线

1. 禁止 `globalThis.fetch` 或任何未注入的 HTTP 通道。
2. 禁止从环境变量读取凭据。
3. `opaqueState` 中不得出现 token、密钥、URL 或签名参数。
4. 供应商报文进入 `detail` 前必须经 `sanitizeProviderDetail` 脱敏。
5. 日志不得打印请求体原文、`Authorization` 头或输出 URL。

## 错误模型

统一使用 `NormalizedProviderError.create(pluginId, version, code, detail)`，`code` 只能取自内核联合类型：

| code | 语义 |
| --- | --- |
| `PROVIDER_NOT_CONFIGURED` | 缺少凭据或配置 |
| `INVALID_CREDENTIAL` | 凭据内容错误 |
| `INVALID_CONFIG` | 配置非法（如白名单外 `baseUrl`） |
| `INVALID_REQUEST` | 请求越界（时长 / 比例 / 分辨率 / 输入图） |
| `PROVIDER_REJECTED` | 供应商确定性拒绝（终态） |
| `PROVIDER_TEMPORARY_ERROR` | 瞬时错误（可重试） |
| `PROVIDER_TIMEOUT` | 超时（内核自动归类） |
| `PROVIDER_EMPTY_RESULT` | 成功响应但没有产物 |
| `UNSAFE_URL` | 越界输出定位符 |
| `OUTPUT_READ_FAILED` | 输出下载失败 / 超限 / 不可解码 |

新插件不得发明联合类型之外的 code。

## 测试门禁

在主仓库中，插件必须同时满足单测与契约集成两层测试，全部无网络、无凭据、全 mock：

```bash
corepack pnpm --filter @musecanvas/providers typecheck
corepack pnpm --filter @musecanvas/providers test
corepack pnpm --filter @musecanvas/providers exec tsx --test "../../tests/integration/*.test.ts"
```

CI（主仓库 `.github/workflows/media-quality.yml`）执行同一门禁，集成步骤按 glob 运行 `tests/integration/` 下全部测试（引号不可省略）；详细覆盖清单见规范第 8 节。

## 接入一个新插件

1. `src/plugins/<id>/index.ts`：定义 `manifest` 与 `class XxxPlugin implements MediaProviderPlugin`，导出 `<ID>_PLUGIN_ID` / `<ID>_PLUGIN_VERSION`。
2. manifest 声明 `credential`（复用已有供应商账号或新建 `providerId`），并为每个模型声明 `capabilities`。
3. `src/plugins/index.ts`：幂等注册进 `globalProviderRegistry` 并 `export *`。
4. 按上一节补齐单测与契约测试。
5. 模型配置侧以 `(plugin_id, plugin_version)` 精确锁定插件；破坏性变更必须升版本并保留旧版本注册。凭据不随版本绑定。
6. 提交前跑通上面三条命令。

完整清单见规范第 9 节；以上传包形式交付见第 10 节。

## 相关链接

- 主仓库：[nextroad-dev/MuseCanvas](https://github.com/nextroad-dev/MuseCanvas)
- 规范原文：[wiki/video-plugin-spec.md](./wiki/video-plugin-spec.md)
- 契约测试：主仓库 `tests/integration/*.test.ts`

## 许可

规范与实现代码来自主仓库 [MuseCanvas](https://github.com/nextroad-dev/MuseCanvas)，该仓库采用 Apache License 2.0；本仓库当前尚未包含独立的 `LICENSE` 文件。`template/LICENSE`（MIT）只是插件模板随包交付的许可证示例。