# 贡献指南

项目处于设计阶段，当前最有价值的贡献是对 [docs/design.md](docs/design.md) 的评审意见（提 issue 讨论）。

## 防膨胀公约

以下规则写给所有贡献者（包括维护者自己），可机检的部分由 CI 强制：

1. **禁设垃圾抽屉**：不允许出现 `utils` / `common` / `shared` / `helpers` 包或目录。一段代码要么属于某个领域目录，要么想清楚它的真名。
2. **边界即代码**：分层依赖方向（L1 不依赖 L3，见 design.md §2.1）由 import-lint 在 CI 强制，不靠 review 自觉。
3. **`packages/` 不增长**：五个成员与分层一一对应，长期固定。想新增顶层包，先在 [docs/adr/](docs/adr/) 提一篇 ADR 说明为什么现有五个都放不下。
4. **provider 是唯一生长轴**：新 provider 按厂商一个目录进 `providers/`，必须通过 `oac conformance`；未通过的先在自己仓库发布，由 README 社区列表收录。
5. **examples 即回归**：示例只许使用公开 API，CI 全量运行——公开 API 的破坏性变更先在这里暴露，而不是在用户升级之后。
6. **发版分轨**：`packages/` 五件套锁同一版本号整体发布；`providers/` 各自独立发版，CI 按路径过滤。

## 扩展机制的宪法条款

任何新的"可定制需求"，先问能否用 Strategy 或 Middleware 表达（design.md §5）；两者都不行，才允许讨论新机制。

## 目录命名

包内按领域分目录，不按模式分：不出现 `factories/`、`base/`、`impl/`。测试与源码同目录（`*.test.ts`），不设顶层 `tests/`。
