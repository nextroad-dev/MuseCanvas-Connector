# MuseCanvas Connector

**MuseCanvas 的媒体 provider 插件与连接器规范仓库**

MuseCanvas 的图像与视频生成能力走「**media provider 内核 + 静态插件**」架构：内核负责注册表、安全 HTTP、错误归一化与输出读取，插件只描述供应商协议，全部由 `apps/worker` 消费。本仓库承载这套插件体系的工程规范，并作为独立 connector / 插件实现的协作入口。

## 仓库状态

当前仓库只包含规范文档；插件内核与内置插件源码仍在主仓库 [nextroad-dev/MuseCanvas](https://github.com/nextroad-dev/MuseCanvas)：

| 路径（主仓库） | 内容 |
| --- | --- |
| `packages/providers/src/core/` | provider 内核：registry、SafeHttpClient、错误归一化、输出读取、输入图校验 |
| `packages/providers/src/plugins/` | 内置静态插件（openai-image、seedream-image、seedance-video、veo-video） |
| `apps/worker/src/jobs/` | 插件消费端：任务状态机与输出摄取 |
| `tests/integration/media-provider-contract.test.ts` | 契约门禁测试 |

## 仓库内容

| 文档 | 内容 |
| --- | --- |
| [`wiki/README.md`](./wiki/README.md) | 规范索引与适用范围 |
| [`wiki/video-plugin-spec.md`](./wiki/video-plugin-spec.md) | 媒体插件开发规范：内核契约、生命周期与状态机、输出契约、安全红线、错误模型、测试门禁 |

> 规范本身即门禁依据：违反契约测试的 PR 不予合入。

## 架构速览

```text
apps/worker
  └─ jobs（任务状态机 / 输出摄取）
       └─ ProviderRegistry（按 id@version 精确解析）
            └─ MediaProviderPlugin（静态插件）
                 └─ ExecutionContext.http ──▶ SafeHttpClient（唯一网络出口）
```

插件**不允许**自行发起网络请求：所有出站流量都必须经过注入的 `ExecutionContext`。

## 核心契约

- **插件接口** `MediaProviderPlugin`：`validateConfig` / `validateRequest` 必须实现；`submit` 是入口；异步任务必须实现 `poll` 与 `cancel`；`openOutput` 负责输出字节获取；`probe` 可选，用于凭据连通性测试。
- **Manifest 硬要求**：按 `id@version` 精确注册；`modalities` 声明 `image` / `video`；`allowedHosts` 为白名单语义（精确主机，或 `*.` 前缀通配匹配子域）；`models` 列出受支持的 `vendorModelId` 与批量 / 输入图上限。
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
| `veo-video` | `1.0.0` | video | 异步轮询、服务账号 JWT 铸造、GCS→HTTPS 映射 |

写异步视频插件时优先参考 `veo-video`，其次 `seedance-video`；同步图像参考 `openai-image` / `seedream-image`。

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
corepack pnpm --filter @musecanvas/providers exec tsx --test ../../tests/integration/media-provider-contract.test.ts
```

CI（主仓库 `.github/workflows/media-quality.yml`）执行同一门禁；详细覆盖清单见规范第 8 节。

## 接入一个新插件

1. `src/plugins/<id>/index.ts`：定义 `manifest` 与 `class XxxPlugin implements MediaProviderPlugin`，导出 `<ID>_PLUGIN_ID` / `<ID>_PLUGIN_VERSION`。
2. `src/plugins/index.ts`：幂等注册进 `globalProviderRegistry` 并 `export *`。
3. 按上一节补齐单测与契约测试。
4. 模型配置侧以 `(plugin_id, plugin_version)` 精确锁定插件；破坏性变更必须升版本并保留旧版本注册。
5. 提交前跑通上面三条命令。

完整清单见规范第 9 节。

## 相关链接

- 主仓库：[nextroad-dev/MuseCanvas](https://github.com/nextroad-dev/MuseCanvas)
- 规范原文：[wiki/video-plugin-spec.md](./wiki/video-plugin-spec.md)
- 契约测试：主仓库 `tests/integration/media-provider-contract.test.ts`

## 许可

规范与实现代码来自主仓库 [MuseCanvas](https://github.com/nextroad-dev/MuseCanvas)，该仓库采用 Apache License 2.0；本仓库当前尚未包含独立的 `LICENSE` 文件。