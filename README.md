<div align="center">
  <img src="docs/assets/brand/icon.svg" width="88" height="88" alt="知枝图标" />
  <h1>知枝 · Zhizhi Agent</h1>
  <p><strong>多用户原生、插槽可扩展的 Agent-Native LLM Wiki 知识与练题系统。</strong></p>
  <p>把 Git 架构沉淀、网页、视频、本地文档与日常问答统一归入标准 Markdown，再通过 Pi Agent、强绑定题库、独立错题本与知识地图真正练会。</p>
  <p>
    <a href="https://github.com/sep-zxy/zhizhi-agent/actions/workflows/ci.yml"><img src="https://github.com/sep-zxy/zhizhi-agent/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://github.com/sep-zxy/zhizhi-agent/actions/workflows/cd.yml"><img src="https://github.com/sep-zxy/zhizhi-agent/actions/workflows/cd.yml/badge.svg" alt="CD" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1f5e47.svg" alt="MIT License" /></a>
  </p>
  <p>
    <a href="#核心架构与工作流">核心架构与工作流</a> ·
    <a href="#预设多页交互与知返题库">预设多页与知返题库</a> ·
    <a href="#当前阶段">当前阶段</a> ·
    <a href="#开始使用与开发">开始使用与开发</a> ·
    <a href="docs/architecture.md">架构文档</a> ·
    <a href="https://github.com/sep-zxy/zhizhi-agent/issues">问题反馈</a>
  </p>
</div>

## 为什么重做 Zhizhi Agent

日常学习与工程实践中的知识散落在代码提交、技术文章、视频教程、PDF 文档与 AI 对话里：收藏之后很少回看，问过 AI 之后转头就忘，而把杂乱的原始材料直接塞给大模型又会严重拉低回答与沉淀质量。

**Zhizhi Agent** 是面向编程学习（同时兼容全领域）的新一代 **Agent-Native LLM Wiki** 系统。它从第一天起就按**多人原生账号隔离**与**可热拆卸插件架构**设计，用全栈 TypeScript Monorepo + **Pi Agent（`@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`）** 驱动核心循环，兼顾**零 Docker 本地极速运行**与**团队共享服务器部署**。

**项目当前处于 V1 基座就绪与业务域并行建设阶段。下面的架构图描述完整目标体系，当前已完成基座与待补齐模块详见[当前阶段](#当前阶段)。**

## 核心架构与工作流

所有原始知识来源不直接进入主循环，而是先通过**插槽式插件**与**异步 AI 解析子循环**清洗为通过运行时 Schema 校验的 **Standard Markdown**，再交由统一三出口（仅收藏 / 进待学 / 预览存卡）与 **Pi Agent 主循环**协作。

![知枝核心链路：插槽来源经统一 Markdown 中间层进入 Pi Agent 主循环并产出知识卡、选择题与知识地图](docs/assets/vision/architecture-overview.png)

| 我想做的事 | Zhizhi Agent 的设计方式 |
|---|---|
| 统一收纳多源资料且不绑死站点 | 将网页、B 站/YT/抖音视频、HTML/PDF/Word/MD、Git 采集器封装为可拆卸插槽（内置 Slot / 外部 MCP），卸载任一插件不影响主干运行 |
| 避免脏文档污染主对话质量 | PDF 表格重排、图片上传对象存储（OSS / LocalFs）、去噪结构化全部前置到**独立 AI 解析子循环**，产出统一 `StandardMarkdown` |
| 从 Git 提交提炼可复用知识 | 跨端采集器（Win/Mac）对多条 Commit 去噪归并并做**架构级抽象总结**，剥离易失源码片段，知识卡与出题彻底脱离原仓库 |
| 日常问答与查知识库不分裂 | 合并为单一「统一问答页」：Pi Agent 自主优先检索当前账号知识库（命中附出处），未命中自动触发联网搜索兜底 |
| 精确控制 AI 何时制卡、出什么题 | 界面提供显式**「生成知识卡」技能开关**与**「题型开关」**，后端按开关动态裁剪下发给 Pi Agent 的 Tool 白名单，关掉即不可能误调 |
| 团队共享服务器与个人本地两用 | V1 原生全表强制 `user_id` + RLS 隔离；本地零 Docker 默认嵌入式 **PGlite + LocalFs + DB 队列**，填环境变量无缝切标准 PG / S3 |

### 统一 Markdown 中间层与双循环解耦

| 层级 | 运行机制 | 解决的核心问题 |
|---|---|---|
| **插槽来源层** (`@zhizhi/plugin-sdk`) | 内置进程槽 + 外部 MCP Server（支持独立 Python `uv` 二开开源解析器） | 强反爬视频站点、复杂版面 PDF/OCR 可随时独立升级或热卸载 |
| **AI 解析子循环** (`runPiSubLoopTask`) | 异步后台任务（`DbJobQueue`），独立于主会话上下文执行结构化提取与 Schema 校验 | 阻断原始大文件噪声进入主循环，保持对话与制卡质量稳定 |
| **Pi Agent 主循环** (`runPiAgentTurn`) | 基于 `@earendil-works/pi-agent-core` 的受控循环，含 `beforeToolCall` 二次拦截与 `finishTurn` 步数上限 | 开关白名单确定性裁剪工具、Pin 槽位硬保护、双通道 SSE 流式输出 |

## 预设多页交互与知返题库

前端不搞失控的全局自由生成 UI，而是按功能划分为 **6 个预设情境独立页**（问答、搜索、知识来源、LLM Wiki、地图与雷达、独立错题本），仅在页内受控卡片槽允许用户与 Agent 投放**白名单预设卡片**并支持右上角「钉住（Pin）」防覆写；交互状态与习惯按 `user_id × page_scene` 持久化记忆，退出重登无缝续接。

![知枝工作台与巩固闭环：6 页预设情境骨架、页内钉住知识卡与选择题卡、右侧开关驱动对话与知识地图联动](docs/assets/vision/workspace-and-quiz-loop.png)

### 强绑定 1:N 题库、独立错题页与地图驱动雷达

- **题目与知识卡强绑定（1:N 多题挂靠）**：独立 `card_questions` 题库表绑定 `card_id` 与版本号。用户通过 PDF、Word 多次补充同一知识点或隔段时间反复复习时，题目持续挂靠在同一知识卡题池中。
- **入库默认异步出 2 道选择题 + 改卡判重**：新卡点「保存」立即返回，后台异步默认生成 **2 道选择题**——① **认知理解题**（概念原理辨析）、② **实际情境应用预测题**（场景推演与架构决策），并在设置中提供全局开关控费；补卡或更新时，AI 对照变更 Diff 与已有题摘要判断覆盖度，未覆盖才增量补题。
- **题型工具化扩展**：每种题型均为独立 Agent Tool——V1 优先交付**选择题（单/多选 + 解析）**，V1.5 通过 Tool 注册表平滑扩展**判断题、填空题、问答题与伪代码预测题**。
- **独立错题页面（完全解耦入库）**：错题单独成页，仅作为客观练题记录不反向耦合 Wiki 入库流程；支持原题重练、变式巩固以及**归档与删除**，防止错题无限积压。
- **知识雷达锚定在知识地图之上**：知识雷达以知识地图的拓扑关系与各节点掌握/错题状态为输入，识别已掌握集群与缺失缺口，推荐下一张最值得学习的待学知识卡。

## 当前阶段

开发基座已按 DeepSeek Harness 工程规范搭建完毕，且 `typecheck` / `oxlint` / 5 条静态门禁 / 单元与多租户测试 / Web 构建全部跑绿：

- **已完成基座**：
  - 全栈 TypeScript pnpm Monorepo（`@zhizhi/brand`、`errors`、`contracts`、`db`、`storage`、`jobs`、`plugin-sdk`、`agent-runtime`、`client-core`、`apps/server`、`apps/web`）。
  - **真实 Pi Agent 核心层**：接入 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`（DeepSeek / OpenAI / OpenAI 兼容中转 + 官方 `fauxProvider` 零费测试真循环）。
  - **零 Docker 双驱动存储与队列**：Drizzle ORM 18 张完整表结构（PGlite 本地嵌入式 / PostgreSQL 生产无缝切换）、`LocalFs / S3` 存储缝隙、去 Redis 的 `DbJobQueue`。
  - **Hono 多租户服务端 + React 19 多页骨架**：JWT 鉴权、双通道 SSE `/api/v1/chat/turn`、按情境页记忆 `/api/v1/canvas-state`、桌面左侧 6 页导航 + 移动端底部 6 Tab + PWA Manifest。
  - **工程门禁与自动化**：`oxlint --type-aware`、5 条静态门禁（禁 `as unknown` / 禁空 `catch` / 防前端误引后端 / 强制租户作用域 / ESM 导出）、`lefthook` Git Hooks 与 GitHub Actions CI/CD。
- **接下来 4 条并行研发主线**（详见 [docs/architecture.md](docs/architecture.md)）：
  1. **A 线（底座与 Wiki）**：知识卡 CRUD、预览确认保存、历史版本对比回退、主题页与中文混合检索。
  2. **B 线（插槽与中间层）**：网页/视频截帧与本地 HTML/PDF/MD 插件、AI 解析子循环 Worker 与外部 Python MCP 插件模板。
  3. **C 线（Git 与地图）**：Win/Mac 跨端只读 Git 采集器（架构总结输出 Standard MD）、知识地图图谱引擎与状态着色。
  4. **D 线（Agent 与知返题库）**：真实 `kb_search`/`web_search` 接线、入库异步 2 选择题与改卡判重 Worker、独立错题页（归档/删除）与地图驱动雷达。

## 开始使用与开发

### 环境要求

- **Node.js** `>= 24.12.0`
- **pnpm** `10.x`
- **Docker**：完全**可选**（本地开发与个人单机零 Docker 直接运行；共享服务器可按需使用 `deploy/docker-compose.yml`）

### 零 Docker 一键启动本地开发

```sh
git clone https://github.com/sep-zxy/zhizhi-agent.git
cd zhizhi-agent
pnpm install
pnpm dev
```

启动后访问：
- Web 前端：`http://127.0.0.1:5173`（自动代理 `/api` 至后端）
- 后端服务：`http://127.0.0.1:3080`（默认自动初始化 `.zhizhi/pgdata` 嵌入式 PGlite 与 `.zhizhi/storage`）

### 全套质量门禁与测试

```sh
pnpm run typecheck        # Host (Node) + Client (Browser) 双编译面严格检查
pnpm run lint             # oxlint --type-aware 检查
pnpm run check            # 5 条自定义静态门禁（含租户隔离与分层依赖边界）
pnpm run test             # 单元与多租户隔离测试（Pi Agent fauxProvider 零 Token）
pnpm run check:all        # 推送前一键完整校验
pnpm --filter @zhizhi/web run build
```

### 共享服务器部署（裸机或 Docker）

配置 `DATABASE_URL=postgres://...` 与对象存储环境变量即可直连宿主机 PG / 云 RDS / 阿里云 OSS；如需容器化拉起 PG（含 pgvector）与 MinIO：

```sh
docker compose -f deploy/docker-compose.yml up -d
```

CI/CD 流水线已内置在 `.github/workflows/`：
- **CI (`ci.yml`)**：每次 Push / PR 自动校验 `typecheck`、`lint`、`check`、`test` 与 Web 生产构建。
- **CD (`cd.yml`)**：推送 `v*` 标签或手动触发时构建发布归档产物，并构建服务端/前端容器镜像（推送至 GHCR）。

## 项目结构

```text
zhizhi-agent/
├── AGENTS.md / CLAUDE.md       # 工程红线与 AI 协作规范（参考 DeepSeek Harness）
├── docs/
│   ├── architecture.md         # 五层架构与能力缝隙索引
│   ├── core-guidelines/        # G/B/F 编码规范
│   ├── specs/                  # 完整产品功能树 (v3.2) 与架构蓝图 (v1.2) HTML
│   └── assets/                 # 品牌图标与架构视觉图
├── packages/
│   ├── shared/
│   │   ├── brand/              # Branded<T> 品牌 ID 与跨环境安全 ID 生成
│   │   ├── errors/             # 结构化错误 ZhizhiError
│   │   └── contracts/          # 跨端共享 Zod 契约（StandardMD / Quiz / Canvas / SSE）
│   ├── infra/
│   │   ├── db/                 # Drizzle ORM + 18 张多租户表 + PGlite/PG 双驱动
│   │   ├── storage/            # StorageProvider 缝隙（LocalFs / S3）
│   │   └── jobs/               # 基于 async_jobs 表的持久化异步队列（无 Redis）
│   ├── ingest/
│   │   └── plugin-sdk/         # 可拆卸来源插件注册表（Slot + MCP）与 MD 校验
│   ├── agent/
│   │   └── runtime/            # Pi Agent Core 主循环 + Pi AI 子循环与多模型路由
│   └── client/
│       └── core/               # 零 DOM 状态机与 SSE 解析（兼容未来移动端）
├── apps/
│   ├── server/                 # Hono HTTP + SSE 后端与多租户鉴权中间件
│   └── web/                    # React 19 + Vite + Tailwind（6 个预设情境独立页 + PWA）
├── scripts/                    # 5 条可执行静态门禁脚本（pnpm run check）
├── deploy/                     # 可选 Dockerfile 与 docker-compose.yml 部署模板
└── .github/workflows/          # CI (门禁/测试/构建) 与 CD (Release / GHCR 镜像)
```

## 数据、隐私与安全边界

- **四重多租户隔离**：JWT/PAT 鉴权上下文注入 → `withTenant()` + PostgreSQL RLS 兜底 → 检索前置 `user_id` 过滤 → 对象存储强校验 `u/{user_id}/...` 路径前缀。
- **写入需确认**：Agent 仅产出知识卡草稿投放至受控画布槽，用户点击保存才正式落库并保留全量历史版本；模型密钥与凭据严禁提交至仓库。

## 贡献与许可证

欢迎通过 Issue 与 Pull Request 参与讨论和共建，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。

本项目基于 [MIT License](LICENSE) 开源。
