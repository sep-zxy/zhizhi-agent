# Zhizhi Core Guidelines

参考 [DeepSeek Harness Core Guidelines](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/core-guidelines/README.md)，按稳定编号约束全仓代码质量。

## G: 通用规范（General）

- **G.1 边界校验、内部可信**：在 HTTP/SSE、配置文件、外部插件输出、LLM Tool JSON、数据库 JSONB 等外部边界必须使用 `@zhizhi/contracts` 的 Zod Schema 校验；同进程已类型化的 TypeScript 函数之间信任静态类型，不写冗余的防御性回退。
- **G.2 品牌化 ID**：跨模块传递实体主键必须使用 `@zhizhi/brand` 导出的品牌类型（`UserId`、`CardId`、`QuestionId` 等），禁止裸 `string`。
- **G.3 结构化错误与显式处理**：可预期失败（参数无效、权限越界、插件不可用、模型超限）统一抛出 `@zhizhi/errors` 的 `ZhizhiError`；禁止无解释的空 `catch {}`。
- **G.4 禁止 `as unknown` 与裸 `any`**：用类型守卫、判别联合（Discriminated Union）+ `assertNever` 或 Zod 解析替代强转。

## B: 后端与 Agent 规范（Backend & Agent）

- **B.1 租户隔离第一**：任何读取或写入业务数据的函数必须显式接收 `TenantContext`，并在 `withTenant()` 内执行；严禁绕过 `user_id` 过滤。
- **B.2 显式配置与显式默认值**：不允许在业务执行函数里藏隐式 `?? default`；在入口处通过 `resolveConfig()` / Zod `.default()` 显式解析为完整 `Spec` 再执行。
- **B.3 Agent 扩展走 Tool/Plugin 缝隙**：新增题型或知识来源时，向 `QuizToolRegistry` 或 `SourcePluginRegistry` 注册，不修改主循环核心分支。
- **B.4 非阻塞异步耗时任务**：解析子循环与知识卡入库默认 2 题生成全部投递至 `@zhizhi/jobs` 异步队列，严禁阻塞用户点击「保存」的 HTTP 响应。

## F: 前端与移动端演进规范（Frontend）

- **F.1 状态与通信零 DOM 化**：SSE 流解析、卡片槽状态机、Pin 保护逻辑、API Client 必须放在 `@zhizhi/client-core`，`apps/web` 只做 React 视图渲染。
- **F.2 受控预设卡片白名单**：前端仅渲染 `PresetCardType` 枚举中已注册的卡片组件，未知类型做显式降级提示而非静默崩溃。
- **F.3 响应式双端优先**：桌面端采用左侧独立页导航 + 主区情境骨架，移动端收敛为底部导航栏 + 问答页卡片抽屉。
