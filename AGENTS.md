# AGENTS.md — 知枝 Web (Zhizhi) 工程与 AI 协作规范

本仓库参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件化与工程门禁思想，采用全栈 TypeScript Monorepo + Pi Agent（`@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`）构建原生多用户 Agent-Native LLM Wiki 知识系统。

在修改 `packages/` 或 `apps/` 前，先阅读 [docs/architecture.md](docs/architecture.md) 与 [docs/core-guidelines/README.md](docs/core-guidelines/README.md)。完整产品与架构规格文档归档在 `docs/specs/`。

## 仓库目录分层

```text
packages/
  shared/
    brand/           Branded<T> 品牌 ID 与跨环境安全 ID 生成
    errors/          结构化错误 ZhizhiError（对标 HarnessError）
    contracts/       跨端共享 Zod 契约（StandardMarkdown、Plugin、Quiz、SceneCanvas、SSE）
  infra/
    db/              Drizzle ORM + 租户上下文 + PGlite(零 Docker)/PostgreSQL 双驱动
    storage/         对象存储 Capability Seam（LocalFs / S3）
    jobs/            基于 async_jobs 表的持久化队列（无 Redis 强制依赖）
  ingest/
    plugin-sdk/      插槽式来源插件协议（内置 Slot + MCP 适配）与 StandardMarkdown 校验
  agent/
    runtime/         基于 Pi Agent 的主循环编排、动态 Tool 裁剪与 Mock Provider
  client/
    core/            零 DOM 前端通信、SSE 解析、页内受控槽与 Pin 状态机（兼容未来移动端）
apps/
  server/            Hono HTTP + SSE 服务端、鉴权与租户中间件
  web/               React 19 + Vite + Tailwind（6 个预设情境独立页 + PWA 响应式骨架）
scripts/             可执行静态门禁（pnpm run check）
deploy/              可选 Docker Compose / 裸机部署模板
docs/                架构说明、编码规范与历史规格 HTML
```

## 常用命令

```sh
pnpm install              # Node >= 24.12.0, pnpm 10.33.0
pnpm dev                  # 零 Docker 同时启动 server + web（本地自动使用 PGlite + LocalFs）
pnpm run typecheck        # 同时校验 Host (Node) 与 Client (Browser) 双编译面
pnpm run lint             # oxlint type-aware 检查
pnpm run check            # 运行全部 5 条仓库静态门禁
pnpm run test             # 单元测试（纯内存/PGlite，不消耗真实 API Token）
pnpm run test:integration # 数据库 + 队列 + 租户隔离集成测试
pnpm run test:e2e         # 真实模型 API 测试（无 DEEPSEEK_API_KEY 自动跳过）
pnpm run check:all        # 推送前完整本地验证（typecheck + lint + check + test）
```

## 工程红线（均由静态门禁或 Lint 强制保障）

1. **V1 原生多租户隔离（不可妥协）**
   - 一切业务表、检索查询、题库、错题、对象存储路径与页内记忆强制绑定 `userId: UserId`。
   - 严禁信任客户端传入的 `userId`；租户身份只能来自鉴权中间件注入的 `TenantContext`。
   - 所有数据库访问必须通过 `@zhizhi/db` 的 `withTenant(db, ctx, fn)` 执行，仓储查询必须显式带 `user_id` 过滤（`scripts/verify-tenant-scope.ts` 校验）。

2. **能力缝隙（Capability Seam）与可拆卸插槽**
   - 任何外部来源（网页、视频、PDF/HTML/MD、Git 采集器）与题型（选择题、判断、填空、问答）必须拆清 **Definition（`@zhizhi/contracts` / `@zhizhi/plugin-sdk`） / Provider（实现） / Consumer（工具或页面）**。
   - 卸载任一来源插件不得阻断主服务启动；所有来源进入主循环前必须经过 AI 解析子循环并满足 `StandardMarkdownSchema`。

3. **Agent 工具确定性控制与写库保护**
   - 用户界面的「生成知识卡」技能开关与「题型开关」通过 `ZhizhiAgentRuntime` 在每轮请求前**动态裁剪下发给模型的 Tools 白名单**，关闭的工具模型不可见也不可调用。
   - 写知识库必须先出草稿预览，由用户显式点击「保存」后才正式入库并异步触发默认 2 道选择题（认知理解 + 情境应用预测）或改卡判重补题。
   - 独立错题页与入库事务完全解耦，支持归档与删除。

4. **双面隔离与零 DOM 客户端逻辑**
   - `packages/shared/*` 禁止依赖 `packages/infra/*`、`packages/agent/*`、`apps/*`。
   - `packages/client/*` 与 `apps/web` 严禁引入任何 `packages/infra/*`、`packages/agent/*` 或 Node 内置模块（`scripts/verify-workspace-deps.ts` 校验）。
   - 前端状态与通信逻辑沉淀在零 DOM 的 `packages/client/core`，以保障未来平滑扩展 Capacitor / React Native。

5. **类型安全与错误处理（对标 DeepSeek Harness）**
   - 严格模式 `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。
   - 跨实体 ID 一律使用 `@zhizhi/brand` 的品牌类型，禁止裸 `string`；禁止调用浏览器在非 HTTPS 下受限的 `crypto.randomUUID()`。
   - 禁止新增 `as unknown` 或 `<unknown>` 强转（`scripts/verify-no-unknown-casts.ts` 校验）；禁止无说明的 `any`。
   - 禁止吞错的空 `catch {}`（`scripts/verify-empty-catch.ts` 校验）；预期内的业务与工具错误统一抛出 `ZhizhiError`。
   - 关闭联合类型 `switch` 必须以 `assertNever` 收尾；异步调用禁止 Floating Promise。

6. **样式与文件格式**
   - ESM everywhere（`"type": "module"`），跨包走 `@zhizhi/*` 包名，包内相对导入带 `.ts` 扩展名。
   - 2 空格缩进、单引号、无分号、多行尾逗号、LF 换行、文件末尾保留一个换行符。
