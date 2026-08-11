# 任务 M0-2：AgentLoop 主循环 + Strategy / Middleware 两大扩展机制

M0 的第二个纵切，建立在 M0-1 的事件溯源底座之上。开工前通读 `docs/design.md` §4–§5、`spec/README.md`，以及 `docs/adr/0002`。

本任务的目标是让"一个 agent 真的能跑起来一个 turn"，并把 design.md 的**宪法条款**（§5 开头）落成代码事实：任何可定制点都必须能用 Strategy 或 Middleware 表达。

## 交付物

### 1. spec/ 扩展

- AgentEvent 增补 AgentLoop 所需事件：`model.request` / `tool.call` / `tool.result` / `permission.requested` / `permission.resolved` 的完整字段（M0-1 已定义骨架的补齐语义），新增 `step.started` / `step.finished`。
- 事件 schema 版本演进策略落地：本次是 v0 内的向后兼容增补，在 `spec/README.md` 写明"增补 vs 破坏性变更"的判定规则与版本号约定。
- 对应 conformance 向量：完整 turn 的合法事件流 ≥2 条，非法时序（如 `tool.result` 无前置 `tool.call`、`permission.resolved` 无前置 `requested`）≥3 条。**时序不变量属于 replay 级校验**（沿用 M0-1R 确立的三阶段判定）。

### 2. ModelPort 与 ToolPort 接口（仅接口 + 测试替身）

- `ports/model.ts`：`ModelPort` 按 design.md §2.2 定义，含 `capabilities`（能力协商位图）、`stream()`（返回 `AsyncIterable<ModelChunk>`）、`countTokens()`。**本任务不实现任何真实厂商适配器**，只提供 `ScriptedModelPort` 测试替身（按预设脚本产出 chunk，供确定性测试）。
- 工具模型：`Tool` 接口（name / JSON Schema / permission 描述 / execute），`ToolRegistry`（注册、查找、分组）。同样只提供测试用工具（echo、故意失败、慢工具）。
- 能力协商的降级路径要有测试：`toolUse: 'prompted'` 时循环走文本协议模拟，且降级事实必须在事件流中可见。

### 3. AgentLoop（模板方法）

按 design.md §4.2 的骨架实现 `runTurn`，每一步产生对应事件、状态可从事件流重建：

- 停止判据、context 组装、模型调用、工具执行、compaction 触发、checkpoint 触发——**每个挂点都是 Strategy 或 Middleware，不是 if/else**。
- **可打断性（Steering）是硬要求**：`AbortSignal` 贯穿所有 Port 调用；每步检查注入队列，用户消息可在 turn 中途插入并影响后续步骤。必须有测试：turn 执行到第 2 步时注入消息，验证第 3 步的 context 包含它、且中断时没有半个事件写入日志。
- Session 状态机（design.md §4.3）：状态从事件流推导，**不单独持久化**；非法转移在类型层面拒绝。
- 崩溃恢复要覆盖到 turn 中途：工具执行到一半进程挂掉，恢复后能判定"该工具调用无结果"并按策略重试或标记失败。这是 M0-1 崩溃恢复能力在真实循环里的第一次兑现，必须有测试。

### 4. Strategy 注册表

- `Strategy` 接口按 design.md §5.1（kind / name / init / apply / metrics）。
- 本任务只实现最小集合，证明机制可用即可：`stop` 的 `max-steps`、`compaction` 的 `none` 与 `sliding-window`、`permission` 的 `allow-all` 与 `policy-file`、`retry` 的 `exponential-backoff`。
- 注册表必须支持**外部包注册**（不改内核即可新增策略），并有一个测试从"外部"注册自定义策略走通全流程。
- `metrics()` 要真的被采集并可读出（为后续策略选型看数据打基础）。

### 5. Middleware 五条管道

按 design.md §5.2 实现洋葱模型（`model` / `tool` / `context` / `memory` / `event`）。要求：

- 顺序、嵌套、短路（不调用 `next`）、异常传播的语义各有测试。
- 至少一个真实用途的内置 middleware：`event` 管道上的成本记账（累计 token 与费用，写入 `turn.finished`）。
- **Hooks 是 Middleware 的配置化形态**（design.md §5.2 末），本任务只需在注释与文档中确立这一点，不实现配置加载。

### 6. examples/

- `examples/minimal-agent/`：用 `ScriptedModelPort` + 测试工具跑通一个完整 turn（含一次工具调用），打印事件流与最终消息历史。只 import 公开 API。

## 约束与护栏

- **不做**：真实 LLM/Sandbox 适配器、Prompt 系统（PromptRegistry 是 M0-3）、MCP/A2A、CLI、memory 策略的真实实现（接口留好即可）。
- kernel 保持零 runtime dependencies。
- `packages/` 不新增成员；新增顶层包需 ADR。
- 每个 Strategy 与 Middleware 挂点都要问一次："这个定制点能否被外部包替换？"不能，就是设计错了。
- 与 design.md 冲突或其未覆盖的决策写 `docs/adr/`（顺延到 0003）。特别是：**turn 中途崩溃后未完成工具调用的恢复语义**很可能需要一篇独立 ADR。

## 验收

- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿；examples 在 CI 中运行。
- 一个完整 turn 的事件流可被 M0-1 的投影重建，且中断 + 恢复后结果与不中断一致（沿用 replay-demo 的验证思路）。
- 外部注册的自定义 Strategy 与 Middleware 各有一个端到端测试。
- 覆盖边界：零工具调用的 turn、工具抛异常、模型流中断、审批被拒、达到 max-steps 停止。

## 工作方式

新分支 `feat/m0-2-agent-loop`，小步 commit，PR 描述含 Decisions / Open Questions / 验收逐条勾选。
