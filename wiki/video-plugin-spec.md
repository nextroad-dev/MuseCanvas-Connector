# 媒体插件开发规范 (Media Plugin Development Spec)

状态:已生效 · 约束对象:`packages/providers/src/plugins/*` 下所有内置媒体插件,以及经管理台上传的第三方插件包(第 10 节) · 依据:主仓库代码(同步至 `c6616dd`,2026-10-02)与 `tests/integration/*.test.ts` 契约

---

## 1. 目标与范围

MuseCanvas 的媒体生成走统一的 **media provider 内核 + 静态插件** 架构。图像与视频插件均由 `apps/worker` 消费,必须遵守本规范;违反契约门禁(`media-provider-contract.test.ts`)的 PR 不予合入。

参考实现:异步视频生命周期优先看 **`veo-video` > `seedance-video`**;同步图像生命周期看 `openai-image` / `seedream-image` 的当前版本。

### 1.1 非目标

- 不覆盖 API 层的凭据管理界面与模型配置流程。

---

## 2. 内核契约 (Kernel Contract)

内核位于 `packages/providers/src/core/`,插件只允许通过注入的 `ExecutionContext` 访问外部世界。

### 2.1 插件接口 `MediaProviderPlugin`

```ts
interface MediaProviderPlugin {
  readonly manifest: MediaProviderManifest
  probe?(config, context): Promise<ProbeResult>            // 可选:凭据连通性测试
  validateConfig(config): void | Promise<void>             // 必须:配置校验,抛 NormalizedProviderError
  validateRequest(request, config): void | Promise<void>   // 必须:请求边界校验,早于任何网络调用
  submit(request, config, context): Promise<OperationResult>
  poll?(remoteId, opaqueState, config, context): Promise<OperationResult>   // 异步任务必须实现
  cancel?(remoteId, opaqueState, config, context): Promise<OperationResult> // 用户取消路径必须实现
  openOutput?(descriptor, config, context): Promise<BoundedOutput>          // 输出字节获取路径
}
```

### 2.2 Manifest 硬要求

| 字段 | 要求 |
|------|------|
| `kind` | 媒体插件固定为 `'media'`(语言模型插件为 `'language'`,见 2.7) |
| `id` / `version` | registry 按 `id@version` 精确注册/查找,`plugins/index.ts` 幂等注册。`id` 须匹配 `^[a-z][a-z0-9-]{1,40}$`,`version` 须为 `x.y.z`。破坏性行为升级版本并保留已被修订引用的旧键;当前视频键为 `1.0.0`,图像活动键为 `1.1.0` 且保留 `1.0.0` |
| `displayName` | 非空字符串 |
| `modalities` | 图像插件为 `['image']`,视频插件为 `['video']` |
| `allowedHosts` | **白名单语义**:出站 HTTP 的每个目标主机都必须命中;语法见 2.3.1。不得为空(空白名单等于禁止一切出站) |
| `credentialSchemas` | 声明可解码的凭据 schema,取值仅限 `legacy-api-key-v1`、`json-v1`、`access-token-v1` |
| `credential` | 插件消费的凭据契约(见 2.5)。内置插件必须声明;缺省时内核按保守规则推导 |
| `models` | **非空**;列出受支持 `vendorModelId`,每个模型以 `capabilities` 声明完整参数契约(见 2.6)。活动版本的 `validateRequest` 必须拒绝清单外的模型 |

`models[]` 的 `maxBatchSize` / `maxInputImages` / `supportedAspectRatios` 已 **deprecated**(分别被 `count` 描述符的 `max`、`inputSlots` / `flags.imageToImage`、`image-size` 描述符的 `presets` 取代),仅因持久化的 manifest 副本仍含这些字段而保留,新插件不应依赖。

### 2.3 网络出口:`SafeHttpClient`(唯一出口)

- 插件 **禁止** 使用 `globalThis.fetch` / 任何未注入的 HTTP 通道;一律经 `context.http`(或 `context.readOutput`)。
- 强制约束:仅 `https:`(错误消息必须包含 "https");主机必须命中 `allowedHosts`(消息含 "allowed hosts");手动跟随重定向且每一跳重新校验,上限 5 跳;响应体按 `maxBytes` 截断检查(含 `content-length` 预检)。
- `ExecutionContext.readOutput(descriptor, { maxBytes, timeoutMs, allowedHosts? })` 支持本次调用追加主机白名单,内核与插件自身白名单取并集。
- `SafeHttpRequestInit.allowInsecureProtocol` 仅放行 `http:`,目前只由宿主的语言模型路径在部署方设置 `ALLOW_INSECURE_PROVIDER_BASE_URL=true` 时使用;媒体插件不得设置它。
- registry 会在把配置的 `baseUrl` 主机追加进白名单时打印告警。

#### 2.3.1 主机白名单语法

内核只有一套语法实现 `hostMatchesAllowlist`(`core/url-guard.ts`),`SafeHttpClient`、Seedance 端点校验与 API 侧保存时校验共用,保证"保存时接受的,运行时一定放行":

| 写法 | 匹配 |
|------|------|
| `api.example.com` | 仅该主机 |
| `*.example.com` | 任意子域,**不含**裸域 `example.com` |
| `*-suffix.example.com` | 后缀前**恰好一个 DNS label**(如 `us-central1-aiplatform.googleapis.com`);`evil.com-suffix.example.com` 不匹配 |

插件内部做主机判断时必须调用 `hostMatchesAllowlist`,禁止自写 `endsWith` 之类的比较。`*-` 通配仅内置插件可用,上传插件只允许精确主机与 `*.` 前缀(见 10.3)。

### 2.4 超时

所有出站调用必须显式传 `timeoutMs`:交互路径建议 `config.timeoutMs ?? 15_000`(probe),任务路径用 `config.timeoutMs`。不允许无超时的网络调用。

### 2.5 凭据契约 `manifest.credential`

凭据属于**供应商账号**(`providerId` + schema + payload),不绑定插件版本:声明相同 `providerId` 且能解码同一 schema 的插件共用凭据(例如一把 Ark key 同时服务 `seedream-image` 与 `seedance-video`),插件升级不会使已存凭据失效。

```ts
type PluginCredentialSpec = {
  providerId: string              // 供应商账号命名空间,如 'openai' / 'volcengine' / 'google'
  schemaId: string                // 必须是 credentialSchemas 之一
  secret: {
    format: 'text' | 'json'       // text = 裸 key;json = 原样粘贴的 JSON 对象
    label: string                 // 管理台表单标签(≤200 字符)
    placeholder?: string
    help?: string
  }
  baseUrl: {
    default?: string              // 必须是 https 且主机命中 allowedHosts
    policy: 'fixed' | 'allowlisted' | 'any-https'
  }
}
```

| `baseUrl.policy` | 语义 |
|------------------|------|
| `fixed` | 只允许 `default` 的主机;留空即取 `default`(此时 `default` 必填) |
| `allowlisted` | 任何命中 `allowedHosts` 的 https 主机 |
| `any-https` | 任意安全 https URL(兼容端点),调用时把白名单扩展到该主机。**仅内置插件可声明** |

- 判定凭据能否服务插件:`credentialServesPlugin` —— `provider_id` 相同且 `schema_id` 在 `credentialSchemas` 内,版本不参与比较。
- 未声明 `credential` 的旧 manifest 由 `pluginCredentialSpec` 推导:`providerId = manifest.id`、首个 schema、首个精确主机作为 `default`、`policy = 'allowlisted'`。
- API 侧模型绑定与预设保存走同一规则:同一供应商账号、可解码 schema、端点满足插件的 `baseUrl.policy`。

内置插件现状:

| 插件 | `providerId` | `schemaId` | `baseUrl` |
|------|-------------|------------|-----------|
| `openai-image` | `openai` | `legacy-api-key-v1` | `https://api.openai.com`;`1.1.0` 为 `fixed`,`1.0.0` 为 `any-https` |
| `seedream-image` | `volcengine` | `legacy-api-key-v1` | `https://ark.cn-beijing.volces.com`;`1.1.0` 为 `fixed`,`1.0.0` 为 `any-https` |
| `seedance-video` | `volcengine` | `legacy-api-key-v1` | `https://ark.cn-beijing.volces.com/api/v3`,`allowlisted` |
| `veo-video` | `google` | `json-v1`(另可解码 `access-token-v1`) | `https://us-central1-aiplatform.googleapis.com`,`allowlisted` |

### 2.6 模型能力声明 `models[].capabilities`

插件 manifest 是模型参数的**唯一事实来源**。每个媒体模型声明自己的参数描述符、几何限制、依赖与编辑能力;同一份声明被浏览器参数 UI、浏览器提交前校验、API 权威校验与插件请求适配器原样消费(校验器在 `@musecanvas/contracts`,四处共用同一实现)。

```ts
interface MediaModelDeclaration {
  id: string
  name?: string
  modalities: ('image' | 'video')[]
  supportsMask?: boolean                      // 编辑端点接受独立 alpha mask
  capabilities?: ModelCapabilities            // 权威参数契约
  defaults?: Record<string, JsonValue>        // 每个值必须对其描述符合法
  deprecated?: boolean                        // 供应商下线但仍可服务,永不作为默认推荐
  deprecationNote?: string
}

interface ModelCapabilities {
  modes: GenerationMode[]
  parameters: ParameterDescriptor[]           // enum / number / image-size(presets + 自定义尺寸区间)等
  inputSlots: InputSlotDescriptor[]
  maxCount?: number
  supportedMediaKinds?: MediaKind[]
  flags?: { textToImage?, imageToImage?, imageEdit?, inpainting?, mask?, transparentBackground? }
  crossFieldConstraints?: { type: 'requires' | 'forbidden' | 'mutually_exclusive' | 'max_product', ... }[]
  declaredBy?: 'plugin-manifest' | 'host-synthesized' | 'undeclared'
}
```

规则:

- **没声明的就是不支持。** `flags` 只认 `=== true`,缺省即"未确认";宿主不会替插件猜参数。
- 未声明契约的模型以 `declaredBy: 'undeclared'` 呈现,在 API 边界被**直接拒绝**,而不是放行任意参数。
- 参数依赖(`dependsOn`)与跨字段约束(如 `background=transparent` 禁止与 `jpeg` 组合)在浏览器、API 与适配器三处同时生效。
- 多个行为一致的模型应共享同一份参数集常量,而不是逐模型复制描述符。
- 模型修订(`model_config_revisions`)固化当时的 `capabilities` 快照;重试按任务锁定的修订重新校验,历史任务按创建时的参数渲染。
- `MediaRequest.parameters` 承载模型声明过、但没有专属类型字段的参数(`background`、`output_format`、`output_compression`、`input_fidelity`、`seed` 等),键名即描述符名;适配器负责转换为供应商线上字段。`extra` 仍是"无类型剩余项",**不要**把契约参数塞进 `extra`。

### 2.7 语言模型插件

内核同时承载 `kind: 'language'` 插件(`LanguageProviderPlugin`:`validateConfig` / `complete` / 可选 `probe`),上下文只有 `SafeHttpClient`,没有二进制输出读取器。`languageProtocols` 取值限 `openai_chat` / `openai_responses` / `anthropic_messages`。内置 `openai-language@1.0.0` 与 `anthropic-language@1.0.0` 以历史语言模型行携带的键注册,请求字节与原生路径一致。

---

## 3. 生命周期与状态机

视频生成是长任务,插件必须完整映射异步内核状态:

```
submit → waiting / submission_unknown / succeeded(同步) / failed
poll   → waiting(含 retryAfterMs) / succeeded(outputs) / failed / canceled
cancel → canceled / waiting(仍在收尾)
```

图像插件为同步生命周期:`submit → succeeded(outputs) / failed`,不实现 `poll` / `cancel`。为避免无幂等保证时重复生成/计费,worker 仅对明确的 HTTP 429 以新 run 有界重试;超时、传输错误、5xx 及“已进入 submitting 但无 remoteId”的重投递均终态失败。确定性 4xx 返回 `failed/PROVIDER_REJECTED`。

### 3.1 `OperationResult.status` 语义(worker 侧后果)

| status | worker 行为 | 插件使用条件 |
|--------|------------|--------------|
| `waiting` | 按 `retryAfterMs` 调度下一次 `poll` | 任务仍在远端执行;瞬时网络错误后的可重试等待 |
| `submission_unknown` | 稍后重新驱动提交 | 提交时遇到瞬时错误(如 429/5xx),**远端未确认受理**;无 `remoteId` |
| `succeeded` | 进入输出摄取 | 必须携带非空 `outputs` |
| `failed` | **终态、不可重试、任务失败** | 仅用于确定性失败:4xx 拒绝、内容安全过滤、空结果、任务终态失败 |
| `canceled` | 释放容量、任务取消 | `cancel()` 确认或 404(任务已不存在) |

**异步远端任务规则:瞬时错误绝不映射为 `failed`。** `NormalizedProviderError.fromHttp` 已把 429/5xx 分类为 `PROVIDER_TEMPORARY_ERROR`(可重试)、其余为 `PROVIDER_REJECTED`(终态);视频插件据此分流。同步图像提交遵守上一节的更保守重试策略。

### 3.2 轮询节奏

- 返回 `retryAfterMs` 表达轮询间隔;尊重供应商 `Retry-After` 响应头并设上限(参考 `seedance-video` 的 `MAX_RETRY_AFTER_MS = 30_000`)。
- worker 会将 `retryAfterMs` 收敛到 `[1s, 600s]`;插件无需自实现退避循环或 `sleep`。

### 3.3 幂等

提交可重试时,若供应商支持,必须携带幂等键(参考 `seedance-video` 的 `x-client-request-id`)。异步任务可用 `submission_unknown` 重新驱动;同步图像供应商当前无可靠幂等键,worker 因此只重试明确的 429,不重试结果未知的超时/传输/5xx。

---

## 4. 输出契约

### 4.1 `OutputDescriptor` 判别式

- `url` 与 `b64Json` **二选一**(XOR),不允许同时存在或同时缺失。
- `index` 必须稠密、从 0 递增。
- `mimeType` 必填;视频一律 `video/*`;活动图像插件仅接受 `image/png` / `image/jpeg`。
- **`url` 必须是 `https:`**。供应商返回 `gs://`、签名 URL 等非直接可下载定位符时,插件在 `poll` 内完成映射,不得把原始定位符直接作为 `url` 输出(参考 `veo-video`:`mapGcsUriToHttps` 显式配置优先,回退规范形式 `https://storage.googleapis.com/<bucket>/<object>`)。

### 4.2 `openOutput`

- 下载前再次校验 `https:` 与主机白名单;拒绝与 `manifest.modalities` 不符的 mimeType。活动图像插件的鉴权请求只能访问官方端点主机;输出 CDN 仅允许无鉴权下载。
- 下载走 `context.readOutput`,继承 `maxBytes` 与超时。`maxBytes` 必须是正安全整数且不超过 100 MB;base64 在解码分配前预检预计字节数。
- 若 `poll` 已把定位符映射为 https,此处的防御校验仍必须保留(输出字节路径是安全边界)。活动图像插件还必须校验 PNG/JPEG 声明 MIME 与实际格式、完整容器尾、单页属性和解码器元数据,并强制完整像素解码;仅解析文件头不算有效输出。

### 4.3 尺寸与时长

- 成功视频结果尽量携带 `durationSeconds`(优先取供应商返回值,回退 `opaqueState` 中记录的请求值)。
- 活动图像插件从解码后的输出取得并强制提供 `width` / `height`:单边不超过 8000 px、总像素不超过 2500 万、宽高比不超过 16:1;通用 `readBoundedOutput` 仍只做尽力解析。

---

## 5. 安全边界(红线)

### 5.1 opaqueState 卫生

`opaqueState` 会被加密后持久化,但仍按“可能泄漏”对待:

- 只允许 JSON 安全的**标识符**:taskId / operationName / model / 请求参数回显。
- **禁止**:token、apiKey、私钥、签名参数、任何 `https?://` URL、`signature=` / `sig=` 片段。
- 契约测试 `assertOpaqueHygiene` 会扫描这些模式,违反即失败。

### 5.2 错误脱敏

- 供应商报文进入 `detail` 前必须经 `sanitizeProviderDetail`(内核自动):剥离 `Bearer` token、`sk-` 密钥与长随机串,截断 1200 字符。
- 插件自定义 `detail` 中同样不得内联凭据(如 SA JWT 的私钥)。

### 5.3 凭据

- 只从 `ProviderConfig`/`credential` 读取;**禁止** 读 `process.env` 或环境默认凭据(参考 `veo-video` `resolveAccessToken` 的注释约束)。
- 宿主侧所有密钥读取(建任务、worker 任务与预处理、DTO)统一经 `stored-credential` 助手:优先 `payload_encrypted`,回退旧 `api_key_encrypted` 列。插件只看到解码后的 `DecodedCredential`,不感知存储形态。
- `validateConfig` 必须校验凭据的必备字段(如 `veo-video` 要求服务账号 JSON 同时含 `client_email` 与 `private_key`),缺失抛 `INVALID_CREDENTIAL` / `PROVIDER_NOT_CONFIGURED`。
- 需要短期 token 的供应商(如 Vertex AI):实现服务账号 JWT 铸造 —— `RS256` 签名断言 → token endpoint(`https://oauth2.googleapis.com/token`)换取 `access_token`,模块级缓存、提前 60s 过期;token endpoint 主机必须进 `allowedHosts`。
- 由配置派生请求主机时必须先校验输入(如 `veo-video` 的 `location` 须匹配 `^[a-z][a-z0-9-]{0,62}$`),防止拼出白名单外或畸形主机。
- `probe` 必须先自校验配置:非法配置抛 `NormalizedProviderError`;配置有效后的连通性/鉴权失败返回 `{ healthy: false, message }`,不得触发生成请求。
- **probe 只在 worker 中执行。** 管理台"测试连通性"会在凭据行上开一个测试请求,API 最多等待约 20s;worker 每 2s 以 `FOR UPDATE SKIP LOCKED` 认领、经可用性门禁调用 `probe` 并回写结果,慢探测返回 `202 pending` 后自行落定。因此 `probe` 必须尊重 `timeoutMs`,且不能假设调用方在线等待。上传插件同样可被测试;未绑定模板的凭据会由同账号的任一插件探测。

### 5.4 日志

worker 侧已有 `redactForLog`;插件自身日志同样禁止打印请求体原文、Authorization 头、输出 URL。

---

## 6. 错误模型

统一使用 `NormalizedProviderError.create(pluginId, version, code, detail, extra?)`,code 取自内核联合类型:

| code | 语义 | 典型场景 |
|------|------|----------|
| `PROVIDER_NOT_CONFIGURED` | 缺凭据/配置 | `validateConfig` 缺 apiKey |
| `INVALID_CREDENTIAL` | 凭据内容错误 | SA 字段缺失、token 铸造失败 |
| `INVALID_CONFIG` | 配置非法 | 非白名单 `baseUrl`、缺 projectId |
| `INVALID_REQUEST` | 请求越界 | 非法时长/比例/分辨率、空 prompt |
| `PROVIDER_REJECTED` | 供应商确定性拒绝(终态) | 400/401/403、内容安全过滤 |
| `PROVIDER_TEMPORARY_ERROR` | 瞬时(可重试) | 429/5xx、传输错误 |
| `PROVIDER_TIMEOUT` | 超时 | 内核自动 |
| `PROVIDER_EMPTY_RESULT` | 空结果 | 成功响应但无视频 |
| `UNSAFE_URL` | 越界输出定位符 | 非 https、白名单外主机、裸 `gs://` |
| `OUTPUT_READ_FAILED` | 输出下载/超限/不可解码 | 超过 `maxBytes`、容器截断、像素解码失败 |

worker 侧 `classifySubmitError` 仍统一规范化错误;异步视频按瞬时分类进入 `submission_unknown` / `waiting`,同步图像仅在诊断明确为 HTTP 429 时创建新 run 重试,其余结果未知错误终态失败。**新插件不得发明联合类型之外的 code。**

### 6.1 边界异常的 message 约定

传输边界错误使用 `SafeHttpError`(`NormalizedProviderError` 子类,`message = "CODE: detail"`),以满足契约对消息文本的断言:

| 场景 | detail 必须匹配 |
|------|----------------|
| 非 `https:` 协议 | `/https/i`(现有文案含 "only HTTPS is permitted") |
| 主机白名单拒绝 | `/allowlist\|allowed\|host/i`(现有文案含 "allowed hosts") |
| 重定向上限 | `/redirect/i` |
| 体积超限 | `/exceed/i` |

插件层抛出的校验错误仍保持 code-only message(worker 有 `err.message === 'CODE'` 的严格比较)。

---

## 7. 参数校验(视频特有)

`validateRequest` 必须在任何网络调用前完成全量校验,`submit` 不允许发送未校验值:

- 模型白名单、非空 prompt、prompt 长度上限;
- `durationSeconds` / `fps` / `seed` / `count`(批量上限,如 `maxBatchSize`) 的枚举或范围;
- 宽高比枚举(如 `16:9`、`9:16`)与分辨率枚举(如 `720p`/`1080p`/`4k`)及组合约束(参考 `veo-video` 的 1080p/4k 仅限标准模型 + 8s);
- 输入图:数量上限、mimeType 仅 `image/png|jpeg`、单张大小上限(参考 20MB)、非空校验;
- 供应商扩展控制(如 `seedance-video` 的 `extractVideoControls`)采用**白名单转发**:只转发显式校验过的字段,未知 `extra` 键一律丢弃。
- 可选值(时长、宽高比、分辨率等)应从本模型的 `capabilities` 描述符读取,而非在适配器里另写一份枚举(参考 `veo-video` 的 `veoDeclaredOptions`)。

### 7.1 输入图角色 `imageRoles`

`MediaInputImage.role` 携带用户在控制台为参考图选择的角色。worker 仅在**每张图都带有可放置角色**(`first_frame` / `last_frame` / `reference_image` / `mask`)时,才把角色列表按图片顺序写入 `request.extra.imageRoles`;部分缺失、旧数据无角色,或含 `prompt_image` / `source_video` 等插件无法放置的角色时不转发,插件按数组位置处理。

插件消费 `imageRoles` 时:

- 只在列表**完整、与图片数量对齐、且描述的是供应商接受的组合**时采用;未知角色、重复角色、有 `last_frame` 却无唯一 `first_frame` 等一律视为无效,回退到位置语义,**不得因此丢弃图片字节或报错**。
- 参考 `veo-video` 的 `resolveExplicitImageRoles`:映射到 `image` / `lastFrame` / `referenceImages`。

> 过渡期说明:worker 目前仍把 `aspectRatio` / `resolution` / `audio` / `duration` / `seed` / `fps` 从 `parameters` 镜像进 `extra`,供两个视频适配器沿用旧读法;新插件应直接读 `request.parameters`。

### 7.2 图像输入特有约束

- `openai-image@1.1.0` / `seedream-image@1.1.0` 在网络调用前校验模型、prompt、size、quality、count 与输入图。
- 输入图统一调用 `core/image-input.ts`:PNG/JPEG 字节签名、单张 10MB、总计 20MB、最多 4 张、边长 `[32,6000]`、最大宽高比 `16:1`。
- 图像输出必须满足 `url` / `b64Json` XOR、HTTPS URL 与 PNG/JPEG MIME;活动版 `openOutput` 必须再次检查 MIME、尺寸/像素边界并完成真实解码。

---

## 8. 测试门禁

新插件必须同时满足以下测试(全部无网络、无凭据、全 mock):

1. **单测** `src/plugins/<plugin>/<plugin>.test.ts`:
   - manifest 快照(版本、modality、白名单、模型清单);
   - `validateRequest` 全边界(非法模型/时长/比例/分辨率/超限输入图);
   - `submit` 精确端点 + 请求体 + 认证头;视频瞬时错误映射 `submission_unknown`,同步图像规范化异常中仅明确 HTTP 429 可供 worker 有界重试;确定性 4xx 返回 `failed/PROVIDER_REJECTED`;
   - 视频 `poll` 状态映射:运行中→`waiting`、成功→判别式输出、任务失败→`failed`、瞬时错误→可重试、安全过滤→`failed`;
   - 视频 `cancel` 成功/404 语义;所有插件 `openOutput` 的 https、白名单与 MIME 拒绝;活动图像额外覆盖截断容器、伪造 MIME、超尺寸/像素和完整解码。
   - 若实现服务账号铸造:覆盖 mint 路径(断言 `Bearer` 头与 token 端点调用)与缓存复用(两次调用仅一次 token 交换)。
2. **契约集成** `tests/integration/media-provider-contract.test.ts`(只增不删):
   - registry 精确键 `<id>@<version>`;活动图像键为 `1.1.0`,历史图像键与当前视频键为 `1.0.0`;
   - manifest 声明(白名单、模型、schema、`credential`、模型 `capabilities`);
   - Safe HTTP 边界(明文协议/白名单外主机/重定向上限/体积上限);
   - 图像同步提交或视频异步生命周期夹具 + `assertOpaqueHygiene` + `assertDiscriminatedOutputs`(https-only URL 输出)。

3. **集成目录** `tests/integration/*.test.ts`:除契约测试外还包括 `capabilities-backfill.test.ts`(manifest 声明的能力回填进模型修订)。CI 以带引号的 glob 运行整个目录,新增的集成测试会自动纳入门禁。

运行方式:

```bash
corepack pnpm --filter @musecanvas/providers typecheck
corepack pnpm --filter @musecanvas/providers test
corepack pnpm --filter @musecanvas/providers exec tsx --test "../../tests/integration/*.test.ts"
```

glob 的引号不可省略:由测试 runner 而非 shell 展开。

---

## 9. 新插件接入清单

1. `src/plugins/<id>/index.ts`:`manifest` + `class XxxPlugin implements MediaProviderPlugin`,导出常量 `<ID>_PLUGIN_ID`/`<ID>_PLUGIN_VERSION`。
2. manifest 声明 `credential`(2.5):复用已有供应商账号时沿用其 `providerId` 与 schema;新供应商取新的 `providerId`。
3. 每个模型声明 `capabilities`(2.6),适配器从声明读取可选值,不另立枚举。
4. `src/plugins/index.ts`:注册进 `globalProviderRegistry`(幂等)并 `export *`。
5. 按第 8 节补齐测试。
6. 模型配置侧:`model_config_revisions` 以 `(plugin_id, plugin_version)` 精确锁定插件;模型注册/修订流程引用该键,破坏性插件变更必须升 `version` 并保留旧版本插件。凭据不随版本绑定,升级无需重建凭据。
7. 提交前本地跑通第 8 节三条命令;CI(`media-quality.yml`)执行同一门禁。

---

## 10. 上传插件(第三方插件包)

除内置静态插件外,管理员可在管理台上传插件包,由 worker 动态加载。该功能默认关闭,需运维设置 `ALLOW_PLUGIN_UPLOAD=true`。上传插件遵守本规范全部契约,另加以下约束。

### 10.1 包格式

> 计划改为单个 zip 包,见 [插件包格式规范(草案)](./plugin-package-spec.md)。以下为当前已实现的格式。

- `multipart/form-data`,只允许两个字段:`manifest`(manifest JSON 文本)与 `file`(**单个 `.mjs` 文件**),各一个。
- 体积上限 `PLUGIN_ARTIFACT_MAX_BYTES` = 5 MiB,在哈希与扫描之前检查。
- 插件对象必须作为 `export default` 导出;worker 加载后会对 bundle 内的 `manifest` 重跑 `validatePluginManifest`,校验 `kind` / `id` / `version` 与上传记录一致,并检查接口必需方法齐全(`PLUGIN_INTERFACE_INVALID`)。
- 制品按 `plugin-packages/<pluginId>/<version>/<sha256>.mjs` 存储,worker 在落盘或 `import()` 之前校验 sha256。

### 10.2 源码扫描 `scanPluginSource`

**零运行时 import**:`@musecanvas/providers` 以 TypeScript 源码导出,worker 缓存目录中的 `import()` 无法解析它,因此 bundle 必须自包含,只有 `import type` 能存活(编译期擦除)。扫描是文本 lint,不是沙箱;真正的隔离来自零 import 规则加宿主注入的白名单 `SafeHttpClient`。

| 规则 | 拒绝内容 |
|------|----------|
| `FORBIDDEN_GLOBAL_FETCH` | `fetch(`、`globalThis.fetch`、`globalThis['fetch']` |
| `FORBIDDEN_PROCESS_ENV` / `FORBIDDEN_PROCESS_BRIDGE` | 任何 `process.*`,含 `process.binding` / `mainModule` |
| `FORBIDDEN_REQUIRE` | `require(`、`createRequire` |
| `FORBIDDEN_DYNAMIC_EVAL` | 运行时代码生成(`eval` / `new Function` 等) |
| `FORBIDDEN_BRACKET_GLOBAL` | 计算属性访问 `globalThis[...]` |
| `FORBIDDEN_RUNTIME_IMPORT` | 非 type 的 `import`、动态 `import()`、`export ... from` 再导出 |
| `FORBIDDEN_NODE_BUILTIN` | `node:*` 及 `fs` / `net` / `http(s)` / `child_process` / `crypto` / `vm` 等内建模块 |
| `FORBIDDEN_TOP_LEVEL_AWAIT` | 顶层 `await`(会在任何检查之前于 import 时执行) |
| `NO_DEFAULT_EXPORT`(warn) | 缺少 `export default` |

注释或字符串中出现的禁用 token 同样会被报告,打包时请去掉。需要签名等加密能力的供应商(如服务账号 JWT)无法使用 `node:crypto`,应改用 `access-token-v1` 等由管理员提供短期 token 的 schema,或改为内置插件。

### 10.3 manifest 校验 `validatePluginManifest`

在第 2.2 节要求之外,上传 manifest 还须满足:

- `allowedHosts` 只能是精确主机名或 `*.` 前缀;拒绝 `*`、`*-` 等其他通配、IP 字面量、`localhost` 及私网/环回/链路本地地址,以及带协议、端口或路径的写法。
- `credential.baseUrl.policy` 只能是 `fixed` 或 `allowlisted`,**禁止 `any-https`**;`credential.providerId` 同样须匹配插件 id 规则。
- 每个媒体模型的 `capabilities` 必须结构合法,畸形声明直接拒绝安装;完全不声明契约是允许的,但该模型会以 `undeclared` 呈现、在 API 边界被拒绝调用。

### 10.4 身份与生命周期

- `PLUGIN_ID_RESERVED`:不能占用内置插件已注册的 `id@version`。
- `PROVIDER_ID_RESERVED`:不能声明(或推导出)内置插件的 `providerId`(`openai`、`anthropic`、`volcengine`、`google` 等),否则会拿到该账号的凭据。上传插件必须使用自己的供应商命名空间。
- **版本不可变**:`(plugin_id, plugin_version)` 一次写入,软删除后也不能复用;修复问题只能升版本重新上传。
- 状态:`pending`(待 worker 加载)→ `active` / `failed`;管理员只能在 `active` ↔ `disabled` 间切换,`failed` 不可重新启用。
- worker 单进程最多保留 40 个已安装插件,import 超时 5s。

---

## 11. 变更记录

| 日期 | 内容 |
|------|------|
| 2026-09-04 | 初版:固化内核契约、状态机语义、安全红线与测试门禁;吸收 Veo SA 令牌铸造、GCS→HTTPS 映射、Seedance 瞬时错误非终态化三项实现的既定事实 |
| 2026-09-04 | 图像模型切换到与 Veo 共用的静态插件内核:`openai-image@1.1.0` / `seedream-image@1.1.0`;保留历史 `1.0.0` 精确键,统一输入图与输出安全契约 |
| 2026-09-15 | 规范迁入 MuseCanvas-Connector。`*-suffix` 通配收紧为单个 DNS label;Veo 校验 `location`;`ALLOW_INSECURE_PROVIDER_BASE_URL` 逃生口(主仓库 `5d7e489`) |
| 2026-09-20 | 模型能力由插件 manifest 声明并驱动控制台(`capabilities` / `defaults` / `MediaRequest.parameters`);上传插件包、源码扫描与 worker 动态加载;语言模型插件内核;视频输入图按 `imageRoles` 放置(主仓库 `1c8cb8e`、`292bb5d`) |
| 2026-10-02 | 插件声明凭据契约 `manifest.credential`;凭据建模为供应商账号、不绑定插件版本;统一 `hostMatchesAllowlist`;probe 移至 worker 执行;集成测试改为整目录 glob(主仓库 `d622468`、`415aa84`、`077ee04`) |
| 2026-10-03 | 同步上述主仓库变更至本规范 |
