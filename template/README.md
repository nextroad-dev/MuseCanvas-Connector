# Example Video(插件模板)

一个可以直接打包、上传的 MuseCanvas 异步视频插件示例。它对接的是**占位供应商** `api.example-video.example`(`.example` 为保留域名,不会解析到真实主机),用来演示插件契约的完整写法;接入真实供应商时替换协议细节即可。

## 目录

```text
template/
├── manifest.json        唯一的 manifest 来源(插件 manifest + package 块)
├── src/
│   ├── index.ts         插件实现(export default 插件对象)
│   ├── host-types.ts    宿主契约类型的本地副本(仅类型,构建时擦除)
│   ├── errors.ts        与 NormalizedProviderError 兼容的错误构造
│   └── url-guard.ts     hostMatchesAllowlist 的逐字副本
├── assets/icon.png      管理台图标(128×128 PNG)
├── test/                生命周期单测(全 mock,无网络)
├── README.md / CHANGELOG.md / LICENSE
└── tsconfig.json
```

## 设计要点

- **manifest 单一来源**:`src/index.ts` 直接 `import manifestFile from '../manifest.json'`,去掉 `package` 块后作为 `plugin.manifest`;esbuild 把 JSON 内联进 bundle,因此 `bundle.manifest` 与 `manifest.json`(去掉 `package`)天然一致(插件包格式规范第 3.1 节)。
- **零运行时 import**:宿主包(`@musecanvas/providers`、`@musecanvas/contracts`)是主仓库内部的 TypeScript 源码包,未发布到 npm,插件仓库无法依赖。所以本模板把需要的类型复制到 `host-types.ts`,全部经 `import type` 使用,编译期擦除;`hostMatchesAllowlist` 与 `sanitizeProviderDetail` 这类纯函数则逐字内联。
- **错误模型**:bundle 无法 `import` `NormalizedProviderError`,worker 侧 `instanceof` 不会命中。模板抛出 `message` 为错误码、携带 `diagnostic` 的 `Error`,这正是 worker `classifySubmitError` 识别上传插件错误的形状;`code` 只取内核联合类型。
- **网络**:只经 `context.http` / `context.readOutput`,每次调用都显式传 `timeoutMs`。
- **生命周期**:`submit` 的 429 / 5xx 返回 `submission_unknown`,`poll` 的瞬时错误返回 `waiting`,只有确定性 4xx、任务失败、空结果才是 `failed`;`cancel` 遇到 404 视为 `canceled`。
- **参数**:可选值与范围从 manifest 的 `capabilities` 描述符读取,只转发声明过的参数。
- **opaqueState**:只放 `taskId` / `model` / `durationSeconds`。

## 构建与打包

在仓库根目录:

```bash
corepack pnpm install
corepack pnpm typecheck                 # 类型检查 template/
corepack pnpm pack:plugin template      # 构建 + 本地校验 + 产出 template/dist/example-video-0.1.0.zip
corepack pnpm check:plugin template/dist/example-video-0.1.0.zip
corepack pnpm test
```

## 基于模板写新插件

1. 复制 `template/` 到新目录,修改 `manifest.json` 的 `id`、`version`、`displayName`、`allowedHosts`、`credential`(使用自己的 `providerId`,不得占用 `openai` / `anthropic` / `volcengine` / `google`)与 `models`。
2. 改写 `src/index.ts` 中的端点与报文映射;保持上面的设计要点。
3. 每次发布都要升 `version`:`(plugin_id, plugin_version)` 一次写入、不可复用。
4. 运行 `pack:plugin <目录>`,在管理台上传产出的 zip。
