# ADR 0004：工具失败分类与模型反馈

- 状态：已采纳（2026-08-11）
- 目标里程碑：M0-3（Prompt 系统）

## 背景

Coding Agent 会频繁遇到编译失败、测试未通过、文件未找到等预期内结果。这些结果表示工具已经完成执行，但任务结果不成功。若工具只能通过抛出异常表达失败，AgentLoop 会把业务结果误判为基础设施故障，并在重试耗尽后终止整个 turn。

工具执行还可能因超时、沙箱不可用或适配器异常而中断。两类失败需要不同的重试和恢复语义。

## 决策

1. 工具失败分为「结果失败」与「执行失败」。结果失败表示工具正常完成并返回失败结果；执行失败表示工具抛出异常，未能正常完成调用。
2. `ToolPort.execute()` 返回带 `outcome` 和 `result` 的 `ToolExecutionResult`。`outcome: 'failed'` 表达结果失败；抛出异常只表达执行失败。结果失败直接写入普通 `tool.result`，不触发 Retry Strategy。
3. `RetryDecision` 使用 `retry`、`feed-back` 和 `fail-turn` 三种动作：
   - `retry`：等待指定时间后重新执行，复用原 `callId`。
   - `feed-back`：写入带结构化错误的失败 `tool.result`，正常结束当前 step，使下一次模型请求可以读取错误。
   - `fail-turn`：写入失败 `tool.result`，终止 turn，并向调用方重新抛出原执行错误。
4. 内置默认策略按操作类型分别设置预算：
   - `tool`：总共尝试 2 次，耗尽后执行 `feed-back`。
   - `model`：总共尝试 2 次，耗尽后执行 `fail-turn`。模型错误没有对应的 `tool.result`，不能直接回喂。
   - `recovery`：总共尝试 1 次，即默认不重新执行结果未知的调用；随后执行 `fail-turn`。只有显式配置才允许恢复时重新执行。
5. `feed-back` 下的 `step.finished.outcome` 为 `succeeded`。该值表示 step 的控制流程已经完整结束，不表示其中每个工具的业务结果都成功。`tool.result.outcome` 保留单次工具结果的状态。
6. 工具执行重试继续遵循 ADR 0003 的 at-least-once 语义。适配器应将稳定的 `callId` 用作幂等键；内核不保证外部副作用只发生一次。

## 后果

- 模型可以读取失败结果并调整参数、重试任务或选择其他工具。
- 工具和 Tool Middleware 的公开返回类型改为显式封套；M0 阶段的外部实现需要同步迁移。
- 默认工具重试提高了暂时性基础设施故障的恢复概率，也增加了非幂等工具重复产生副作用的风险。
- `tool.result.outcome: 'failed'` 且不含 `error` 表示结果失败；同时包含 `error` 表示执行失败。

## 本 ADR 不决定

- 不定义基于错误类别自动判断不可恢复错误的规则；可通过自定义 Retry Strategy 或显式配置选择 `fail-turn`。
- 不提供跨进程持久化的 attempt marker。多次恢复时严格执行重试预算留待 M2 处理。
- 不把 Retry 动作写入事件。若进程在失败 `tool.result` 写入后、`step.finished` 写入前中断，恢复端无法仅凭事件还原原动作；该问题作为后续恢复契约的待决项。
