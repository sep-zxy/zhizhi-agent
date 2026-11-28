# Agent Note: 抖音来源插件私有化轻量改造（替代重型 DTK 边车）

Status: implemented

## Problem

在 [2026-11-28-ingest-capabilities-and-douyin-slot.md](./2026-11-28-ingest-capabilities-and-douyin-slot.md) 中，公共基础能力域（`packages/capabilities/{mcp-client,asr,media-frames}`）与通用编排管线（`packages/ingest/pipeline`）已落地，但初始抖音插件通过整套 `Evil0ctal/Douyin_TikTok_Download_API` v5 Docker 栈（TimescaleDB PG17 + Redis 8 + 独立控制台 + 手动导 Cookie）运行，与知枝「零 Docker 轻量启动、仅提取所需功能做私有化改造」的定位背离。

## Decision

移除 `packages/ingest/plugin-douyin-dtk` 与 `deploy/docker-compose.dtk.yml`，落地纯 TypeScript 进程内插件 **`packages/ingest/plugin-douyin`（`@zhizhi/plugin-douyin`，`mode: 'in_process'`）**，保留 `@zhizhi/cap-mcp-client` 供后续外部 MCP 来源复用：

1. **链接识别与安全短链展开**：`extractDouyinUrlFromText` / `isDouyinShareInput` 识别带中文口令的抖音分享文本、短链、视频页、图文页与精选 `modal_id`；短链以 `redirect: 'manual'` 最多 3 跳展开并校验抖音白名单域名防 SSRF。
2. **双轨免 Cookie 解析**：
   - Track 1（主通道）：依次请求 `api5-normal-c-hl.amemv.com` 与 `aweme.snssdk.com` 的 `/aweme/v1/feed/?aweme_id={id}&aid=1128`，按 `aweme_id` 精确匹配；
   - Track 2（降级与图集通道）：请求 `www.iesdouyin.com/share/video/{id}/` 并用字符级花括号栈 `extractJsonObjectAfter(html, '_ROUTER_DATA')` 提取 `videoInfoRes.item_list[0]`。
3. **媒体优选、原生字幕优先与图集处理**：
   - 视频流按 `is_h265 === 0` 最高码率优先，兜底最高码率流与 `play_addr`，自动清洗 `/playwm/ → /play/` 并升清 `720p → 1080p`；
   - 若存在 `cla_info.caption_infos` / `subtitle_infos`，优先拉取并通过 `@zhizhi/cap-media-frames` 的 `parseSubtitles()` 输出 `TranscriptSegment[]` 且设 `needsAsr: false`，否则交回公共 `AsrProvider`；
   - 图文笔记自动下载无水印原图进 `binaryAssets` 并跳过 ASR 与抽帧。
4. **服务端默认接入与前端入口**：`apps/server` 默认注册 `createDouyinPluginFromEnv(env)`，前端 `/sources`（`apps/web/src/SourcesPage.tsx` + `packages/client/core/src/api.ts`）直接提供多租户登录、插槽健康展示、口令提交、异步队列进度监控与 `StandardMarkdown`/草稿预览。

## Alternatives considered

### Why not 继续保留 DTK v5 容器边车？

DTK v5 绑定独立 TimescaleDB + Redis + 管理后台 + 身份池运维，复杂度远超知枝本体；单条公开分享链接解析走进程内纯 HTTP 双轨协议即可免 Cookie 毫秒直出，无需第二套 SaaS 栈。

### Why not 裁剪 DTK v5 Python 代码作轻量边车？

DTK v5 平台适配器与内部 Redis 调度器、identity 模型耦合较紧，剥离维护成本高于 ~350 行纯 TS 进程内适配器，且额外引入 Python 运行时。

## Consequences

- **正收益**：知枝回到真正的**零 Docker 一键 `pnpm dev`**，抖音插槽启动即在线就绪（免 Cookie）；本机真实样本（`https://v.douyin.com/enP6_nqH4bQ/` → `aweme_id=7700419372729168881`）在浏览器 `/sources` 端到端实测通过：免 Cookie 拿到作者 `RabbittuX`、文案、标签与 9.86 MB 无水印流，后台 Worker 调用本机 `ffmpeg` 自动完成 `L2` 三时间点截帧（`00:26`、`01:28`、`02:31`，共 3 张 ~44KB JPG 写入 `u/{userId}/assets/*.jpg`），产出的 `StandardMarkdown` 写入 `raw_sources` 并输出未落正式库的草稿预览。
- **权衡与后续**：无原生字幕的抖音视频在未配置 `ZHIZHI_ASR_BASE_URL` / `ZHIZHI_ASR_API_KEY` 时会给出清晰降级提示并保留文案 + `L2` 截帧；配置云端/本地时间戳 ASR 与真实 LLM Key（`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`）后可自动升级为完整语音转写 + `L1` 字幕定位截帧 + 真实总结。
- **验证**：`pnpm run check:all`（双端 `typecheck`、`oxlint --type-aware`、5 条仓库门禁、10 个测试文件共 95 项单测）与 `pnpm run build` 全量通过。
