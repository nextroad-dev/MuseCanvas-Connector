# MuseCanvas Wiki

MuseCanvas 媒体插件体系的工程规范与决策记录。规范以主仓库 [nextroad-dev/MuseCanvas](https://github.com/nextroad-dev/MuseCanvas) 的代码为准,最近一次同步至 `c6616dd`(2026-10-02)。

## 规范索引

| 文档 | 内容 |
|------|------|
| [媒体插件开发规范](./video-plugin-spec.md) | media provider 内核契约、凭据契约、模型能力声明、生命周期、安全边界、错误模型、测试门禁、上传插件 |
| [插件包格式规范(草案)](./plugin-package-spec.md) | 上传插件改为单个 zip 包:包结构、`manifest.json` 的 `package` 块、解压安全校验、存储与加载、迁移 |

## 适用范围(主仓库路径)

- `packages/providers/src/core/` — provider 内核(registry / safe http / url-guard / credential-spec / plugin-scan / output reader / errors)
- `packages/providers/src/plugins/` — 内置插件(`openai-image`、`seedream-image`、`seedance-video`、`veo-video`、`builtin-language`)
- `packages/contracts/src/media-parameters.ts` — 模型能力与参数描述符契约(浏览器、API、插件共用)
- `apps/worker/src/jobs/` — 插件消费端(任务状态机、输出摄取)
- `apps/worker/src/plugins/` — 上传插件加载器与可用性门禁
- `apps/api/src/modules/admin/plugins.ts`、`apps/api/src/modules/admin/credentials/` — 插件上传与凭据管理
- `tests/integration/*.test.ts` — 契约门禁(无网络、无凭据、全 mock)
