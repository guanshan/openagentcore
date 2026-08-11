# 任务 M0-1：工程基座 + spec 首批 Schema + kernel 事件模块

这是 OpenAgentCore 的第一个编码任务。开工前**必须通读** `docs/design.md`（重点 §2–§5、§16）、`CONTRIBUTING.md`、`docs/adr/0001`。本任务是 M0 里程碑的第一个纵切，不是整个 M0。

## 交付物

### 1. 工程基座（monorepo 根）

- `tsconfig.base.json`：strict 全开，ES2022 target，各包继承。
- vitest（测试）、eslint + prettier（风格）、changesets（发版，仅初始化配置）。
- **import 边界强制**：dependency-cruiser 或等价工具，规则至少包含——kernel 不得 import 其他任何 workspace 包；禁止出现 `utils`/`common`/`shared` 目录。规则跑进 CI。
- GitHub Actions：`ci.yml`，push/PR 触发 lint + typecheck + test + build。

### 2. spec/ 首批协议（本任务的核心契约）

- `spec/schemas/agent-event.v0.json`：AgentEvent 的 JSON Schema，覆盖 design.md §4.1 列出的十种事件；每个事件带 `seq`（单调递增）、`sessionId`、`ts` 公共字段。设计 `$id` 与版本号约定并写进 `spec/README.md`。
- `spec/schemas/trajectory.v0.json`：Trajectory = 事件流 + 元数据（spec 版本、agent 定义摘要）。
- `spec/vectors/`：≥5 条手写一致性测试向量（合法/非法事件流样例，JSON 文件 + 期望结果），格式约定写进 `spec/README.md`。向量将被 kernel 测试直接消费。

### 3. packages/kernel 事件模块

- `src/events/`：与 schema 对应的 TS 类型（手写，暂不上代码生成）；`EventLog` 接口（`append` / `read(fromSeq)` / `subscribe`）；`InMemoryEventLog` 实现（Null Object 原则的默认件）；快照接口 `SnapshotStore` 定义 + 内存实现。
- `src/events/projection.ts`：至少一个投影——从事件流重建消息历史（含 compaction 事件的折叠语义）。
- 崩溃恢复的最小证明：测试中写入事件流 → 丢弃内存状态 → 从 EventLog（快照 + 尾部事件两条路径）重建投影，结果一致。
- 测试与源码同目录（`*.test.ts`）；用 ajv 在测试里校验所有构造的事件符合 spec schema；消费 `spec/vectors/` 全部向量。

### 4. examples/

- `examples/replay-demo/`：一个可 `pnpm run` 的脚本示例——产生事件流、模拟中断、恢复重建，打印前后一致性。只 import kernel 公开 API。

## 验收标准

- 根目录 `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿；CI 全绿。
- kernel 的 `package.json` **零 runtime dependencies**（devDependencies 不限）。
- 边界 lint 能真实拦截：故意在 kernel 里 import runtime 应使 CI 变红（在 PR 描述中演示说明即可，不留脏代码）。
- 覆盖边界用例：空事件流、仅快照无尾部、非法事件被 schema 拒绝、seq 乱序拒绝 append。

## 约束与护栏

- 遵守 CONTRIBUTING 防膨胀公约全部条款；`packages/` 不新增成员，`coding/runtime/ui/cli` 四包本任务不动（保留 README 即可）。
- 不引入 turbo/nx 等构建编排（当前规模 pnpm 原生脚本足够）；每引入一个 devDependency 在 PR 描述里给一句理由。
- 本任务**不做**：真实 model/sandbox 适配器、compaction/memory 策略实现、Prompt 系统、CLI、AgentLoop 主循环（下个任务）。发现 scope 之外想做的，记入 PR 的 Open Questions，不要顺手做。
- 与 design.md 冲突或其未覆盖的决策点：小事在 PR 描述"Decisions"列出；影响架构的写 `docs/adr/`（顺延编号）。

## 工作方式

新分支 `feat/m0-1-bootstrap`，小步 commit，完成后开 PR 到 main。PR 描述包含：Decisions（自行拍板的点）、Open Questions（需要维护者定夺的点）、验收标准逐条勾选。
