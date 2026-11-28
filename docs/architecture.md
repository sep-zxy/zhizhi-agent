# 知枝 Web 系统架构规范（Engineering Architecture）

本文档是 `docs/specs/zhizhi-web-architecture-v1.html` 的工程落地索引，定义各包职责边界与核心能力缝隙（Capability Seam）。

## 1. 五层架构与包映射

| 架构层 | 对应包 / 应用 | 核心职责 |
| :--- | :--- | :--- |
| **L1 展示与多页情境层** | `apps/web` + `packages/client/core` | 6 个预设情境独立页（问答/搜索/来源/Wiki/地图雷达/独立错题）、页内受控卡片槽 + Pin 钉住、零 DOM 状态与 SSE 客户端 |
| **L2 接入与多租户鉴权层** | `apps/server` | Hono HTTP + SSE 协议网关、JWT/PAT 鉴权中间件、`TenantContext(userId)` 注入 |
| **L3-A Agent 主循环层** | `packages/agent/runtime` | 封装 `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`；按 UI 开关动态裁剪 Tool 白名单；桥接 SSE 与 `canvas_op` |
| **L3-B 公共能力与插槽解析层** | `packages/capabilities/*` + `packages/ingest/*` | 公共能力（`@zhizhi/cap-mcp-client`、`cap-asr`、`cap-media-frames`）、可拆卸 `SourcePlugin` 注册表（含私有化进程内插件 `plugin-douyin`）、通用 `ingest-pipeline` 与 `StandardMarkdown` 强校验 |
| **L4 基础设施与存储层** | `packages/infra/{db,storage,jobs}` | Drizzle ORM（PGlite 零 Docker / PostgreSQL 双驱动 + RLS 事务钩子）、LocalFs/S3 对象存储、基于 `async_jobs` 表的持久化队列 |
| **共享契约层** | `packages/shared/{brand,errors,contracts}` | 品牌 ID、结构化 `ZhizhiError`、Zod Schema（零外部业务依赖，Host 与 Client 共用） |

## 2. 核心设计铁律（ADR 摘要）

1. **ADR-01 原生多人隔离**：所有数据表与对象键强绑定 `user_id`，本地单人通过默认单账号复用同一套底座。
2. **ADR-02 插槽式来源插件**：抖音解析在服务端进程内运行，无需独立容器；保留外部 MCP Server 扩展缝隙，卸载任一插件不阻断主干运行。
3. **ADR-03 统一 Markdown 中间层 + AI 子循环**：原始输入禁止直入主循环，先经异步子循环转为通过 `StandardMarkdownSchema` 校验的干净文档。
4. **ADR-04 Git 剥离代码片段**：跨端采集器与子循环仅沉淀架构级抽象 Markdown，脱离原仓库代码快照。
5. **ADR-05 统一问答入口 + 动态工具裁剪**：`kb_search` / `web_search` 常驻自主路由；`draft_wiki_card` 与各类 `quiz_generate_*` 工具由 UI 开关在每轮请求前硬裁剪。
6. **ADR-06 预设情境多页 + 页内有限调整**：按功能分页固定情境骨架，页内卡片槽仅允许白名单预设卡片，支持 Pin 钉住防覆写，记忆表按 `user_id × page_scene` 持久化。
7. **ADR-07 强绑定 1:N 题库 + 入库异步 2 选择题 + 改卡判重**：独立 `card_questions` 表挂靠多题；新卡保存立即返回并投递异步出题任务（认知理解 + 情境应用预测）；补卡先比对 Diff 与已有题覆盖度再增量出题。
8. **ADR-08 独立错题页解耦 + 地图驱动雷达**：`wrong_book` 仅作客观记录并支持 `active / archived / deleted`；知识雷达显式依赖知识地图拓扑与掌握度推荐下一张待学卡。

## 3. 4 人并行开发切分

- **A 线（底座与 Wiki）**：`packages/infra/*`、`packages/domain/auth`、`packages/domain/wiki`
- **B 线（插槽与中间层）**：`packages/ingest/*`、外部 MCP 解析插件
- **C 线（Git 采集与知识地图）**：`apps/git-collector`、`packages/domain/graph-radar`
- **D 线（Agent、多页画布与题库错题）**：`packages/agent/*`、`packages/domain/quiz`、`packages/domain/memory`、`packages/client/core`、`apps/web`
