# 参与贡献 · Contributing

感谢参与 **知枝 · Zhizhi Agent** 的开发！本仓库采用全栈 TypeScript Monorepo（参考 DeepSeek Harness 工程规范）与 Pi Agent 运行时。

## 开发前必读

1. [AGENTS.md](AGENTS.md) — 工程红线、目录分层与 AI 协作规则
2. [docs/architecture.md](docs/architecture.md) — 五层架构与 4 人并行接口边界
3. [docs/core-guidelines/README.md](docs/core-guidelines/README.md) — 通用 / 后端 / 前端编码准则

## 本地验证流程

提交 PR 前请在本地跑通以下检查（`lefthook` 也会在 `pre-commit` 与 `pre-push` 自动执行）：

```sh
pnpm install
pnpm run check:all
pnpm --filter @zhizhi/web run build
```

## 提交与分支约定

- 禁止直接向 `main` 强推；从 `main` 切功能分支发起 Pull Request。
- Commit message 使用简洁准确的中文描述本次变更。
- 涉及数据库 Schema、跨包 Zod 契约或 `AGENTS.md` 红线变更时，请在 PR 描述中明确标注影响范围并同步更新测试。
