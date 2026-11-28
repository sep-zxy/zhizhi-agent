# Agent Note: 公共能力域拆分与抖音 DTK v5 插槽验证架构

Status: implemented

## Problem

知枝在 `packages/ingest/plugin-sdk` 中原本仅定义了 `SourcePlugin` 协议与 `StandardMarkdownDocumentSchema`，尚未落地真实外部来源插件与通用采集编排管线。若把语音转写（ASR）、字幕清洗、重点帧截图与 MCP 协议客户端直接耦合进抖音插件，后续扩展 B 站、小红书、YouTube 或本地视频时会重复建设音视频加工逻辑。同时，原 `SourcePlugin` 缺少分享口令匹配、长耗时 `AbortSignal`/进度回调，以及 `binaryAssets` 到 `StandardMarkdownFrontmatter.assets` 的落盘回填缝隙。

## Decision

按「四域解耦」拆分采集链路，并以路线 A（`Evil0ctal/Douyin_TikTok_Download_API` v5 Streamable HTTP MCP）落地首个抖音来源插槽插件，同时保持知枝主服务零 Docker 启动与多租户写库红线：

1. **新增独立公共基础能力域 `packages/capabilities/*`**（与 `packages/ingest/*` 并列，受 `scripts/verify-workspace-deps.ts` 限制禁止被 `packages/shared/*`、`packages/client/*`、`apps/web` 引入）：
   - `packages/capabilities/mcp-client`（`@zhizhi/cap-mcp-client`）：提供无状态 `StreamableHttpMcpClient`（支持 JSON 与多帧 `text/event-stream` 响应、Bearer / `X-API-Key` 鉴权、`AbortSignal` 与超时、错误转 `ZhizhiError`）。
   - `packages/capabilities/asr`（`@zhizhi/cap-asr`）：定义跨平台 `AsrProvider` 能力缝隙（含 `supportsTimestamps` 标识），内置 `OpenAiCompatibleAsrProvider`（带时间戳段落）与零配置占位 `DisabledAsrProvider`。
   - `packages/capabilities/media-frames`（`@zhizhi/cap-media-frames`）：提供 WebVTT/SRT 字幕解析归一化（`parseSubtitles`）及基于 FFmpeg 的三级兜底重点帧截图器 `FfmpegKeyframeExtractor`（`L1` 字幕时间戳定向抽帧 → `L2` 无时间戳等分抽帧 → `L3` 封面图兜底）。
2. **增量升级 `packages/ingest/plugin-sdk`（`@zhizhi/plugin-sdk`）**：
   - 在 `SourcePlugin` 上新增可选 `match?(input)` 与 `PluginExtractRuntime`（透传 `signal` / `onProgress` / 共享能力引用），在 `SourcePluginRegistry` 上新增 `inspectHealth()`。
   - 在 `RawExtractedBundle` 上新增 `transcript`、`mediaRef`、`fallbackCoverUrl`、`needsAsr`、`needsKeyframes`，并让 `buildAndValidateStandardMarkdown` 接收已落盘的 `StandardAssetRef[]`。
3. **新增通用采集编排与子循环 `packages/ingest/pipeline`（`@zhizhi/ingest-pipeline`）**：
   - `IngestPipelineService` 串联「插件路由与提取 → 字幕优先/公共 ASR 补齐 → 三级重点帧截图 → `@zhizhi/storage` 租户资产落盘（`u/{userId}/assets/*`）→ `runPiSubLoopTask` 解析子循环 → `buildAndValidateStandardMarkdown` 强校验 → `withTenant` 幂等写入 `raw_sources`」。
   - 按 `disposition` 分流：`todo_queue` 幂等写入 `todo_items`；`wiki_card` 仅产出 `wikiCardDraft (requiresUserSave: true)`，不直接写入 `wiki_cards`。
   - 通过 `registerJobHandler` 挂载到 `@zhizhi/jobs` 的 `DbJobQueue('ingest_sub_loop')`，纳入 `scripts/verify-tenant-scope.ts` 静态门禁。
4. **新增抖音 DTK v5 插槽插件 `packages/ingest/plugin-douyin-dtk`（`@zhizhi/plugin-douyin-dtk`）与边车模板 `deploy/docker-compose.dtk.yml`**：
   - `DouyinDtkSourcePlugin`（`mode: 'mcp'`）识别抖音分享口令/短链/视频页/图文页/精选 `modal_id`，通过 `McpClientHandle` 调用 DTK v5 的 `pool_status`、`parse_url`、`download_media`、`transcribe_video`、`get_task_result`（含 `pending` 轮询与 Zod 边界校验）。
   - 图文笔记直接拉取无水印原图进入 `binaryAssets` 并跳过 ASR 与抽帧；视频默认优先复用 DTK 离线 FunASR，未启用或已配置时间戳 `AsrProvider` 时自动交回公共 ASR 与 L1/L2/L3 截图管线。
   - 未配置 `DTK_MCP_URL` 时插件安全注册为 standby 状态，`healthcheck()` 返回 `{ ok: false }`，不阻断主服务启动。
5. **服务端路由与后台 Worker 接入（`apps/server/src/app.ts`、`apps/server/src/main.ts`）**：
   - 新增租户隔离接口：`GET /api/v1/plugins`、`POST /api/v1/sources/ingest`、`GET /api/v1/sources`、`GET /api/v1/sources/:id`、`GET /api/v1/jobs/:id`。
   - 在 `packages/infra/jobs` 补齐 `getByIdForTenant`、`runNextPending` 与非重入轻量轮询 `startWorker()`（返回停机 disposer），并在 `apps/server/src/main.ts` 启动后台消费循环与 `SIGINT`/`SIGTERM` 优雅停机。

## Alternatives considered

### Why not 把公共能力收敛到 `packages/ingest/capabilities`？

ASR、受控 MCP 客户端与媒体抽帧（以及后续 OCR/PDF 解析）并不只服务于采集单链路。将其独立为顶层域 `packages/capabilities/*` 能让平台插件域与基础能力域保持正交，并由 `verify-workspace-deps` 直接施加单向依赖边界（`shared → infra → capabilities → ingest → server`）。

### Why not 把 ASR / FFmpeg / DTK 暴露为 Pi Agent 主循环工具？

知枝是原生多租户 Web 应用，主循环工具直接进入大模型上下文并受 Prompt 注入面影响。将裸媒体执行、平台 Cookie 或 MCP 密钥留在服务端确定性编排层，主循环仅消费带 `userId` 隔离的 `StandardMarkdownDocument`，避免工具膨胀与跨租户越权。

### Why not 采用 MediaCrawler / EchoLens / Douyin-Watermark-Free-Parser 或全自研抖音逆向？

`MediaCrawler` 与 `Douyin-Watermark-Free-Parser` 均为非商用许可，`EchoLens` 为 `GPL-3.0-only`，`ucmao/media-parser` 已公告将于 2027-01-01 前停更移除解析源码；在主仓自研 `a_bogus` 与风控对抗维护成本过高。`Evil0ctal/Douyin_TikTok_Download_API` v5 为 Apache-2.0，提供自愈身份池、原生 `/mcp/` 与离线 FunASR，且同时覆盖抖音、TikTok 与 B 站。

## Consequences

- **正收益**：后续接入 B 站、小红书、YouTube 或本地视频时，只需新增 ~150 行薄插件适配器，即可直接复用 ASR、字幕归一化、三级重点帧截图、租户资产落盘、AI 解析子循环与 `raw_sources` 三出口编排；主服务在无 Docker、无 DTK 容器或卸载插件的情况下保持零阻塞运行。
- **权衡与约束**：真实抖音链接联调需要额外启动 `deploy/docker-compose.dtk.yml`（或对接已有 DTK v5 实例）并配置 `DTK_MCP_URL` / `DTK_API_KEY`；若仅依赖 DTK 离线 FunASR 而未配置带时间戳的 `AsrProvider`，视频截图自动走 `L2` 等分抽帧或 `L3` 封面兜底，配置时间戳 ASR（`ZHIZHI_ASR_BASE_URL` / `ZHIZHI_ASR_API_KEY`）后自动升级至 `L1` 精准时间轴抽帧。
- **验证**：`pnpm run check:all` 全量通过（双编译面 `tsc --noEmit`、`oxlint --type-aware`、全部 5 条仓库静态门禁、9 个测试文件共 68 项单元测试，含 PGlite 真实双租户隔离与 `apps/server` 端到端 Mock 联调）。
