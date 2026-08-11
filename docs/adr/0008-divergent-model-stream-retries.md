# ADR 0008：分叉模型流的可审计作废与重来

- 状态：已采纳（2026-08-11）
- 目标里程碑：M1-2（模型重试现实化）
- 取代：[ADR 0006](0006-model-stream-retry-prefix.md) 的默认严格前缀语义

## 背景

真实随机模型在完全相同的请求上也不保证逐字复现。连接闪断后，第一次尝试可能已经持久化 `The answer is `，第二次却从 `The answer would be ` 开始。把这种分叉解释成 Kernel 不变量错误，会让原本可恢复的 Provider 故障稳定升级为 turn 失败。

Provider Adapter 不应缓存第一次输出、补造调用 ID 或改写第二次输出来制造确定性。事件流必须如实保留每次已观察到的输出，同时让消息投影只呈现当前有效尝试。

## 决策

1. 新增 `model.attempt.discarded`。事件关联 `stepId` 与 `requestId`，用包含端点的 `discarded` 区间指向此前持久化的 `model.delta`，并以 `provider-failure` 或 `recovery` 说明重新开始的原因。原始 delta 不从 EventLog 删除。
2. 模型流重试默认采用 `discard`：Retry Strategy 批准重试后，若失败尝试已有持久化 delta，则在下一次模型尝试前写入作废事件；新尝试从空 journal 开始，允许文本、工具调用 ID 和参数分叉。
3. 消息投影通过与 compaction 共用的区间选择和条目移除原语折叠被作废的文本 delta。被作废的工具 delta 本来不直接进入消息投影，工具恢复和批次补全也只读取未被作废的 delta。
4. `strict-prefix` 保留为显式模式，继续执行 ADR 0006 的 Unicode code point 与完整工具调用原子匹配。它适用于确定性回放、调用方确认的确定性生成或其他能保证前缀稳定的场景；Kernel 不根据 temperature 或 Provider 名称自动猜测。
5. `AgentLoopOptions.modelStreamRetryMode` 表达模式，默认值为 `discard`。实际模式同时写入 `model.request.retryMode`，恢复同一请求时以持久化值为准，避免进程重启后的配置漂移改变语义。
6. 默认模式恢复未完成的模型 step 时，先用 `recovery` 原因作废仍有效的持久化 delta，再重发原始 `model.request.assembled`。严格模式继续重放并校验已有前缀。
7. Model Middleware 的 `chunks` 仍保留本进程内各次尝试的原始 chunk；对外消息历史只物化未作废的 canonical 输出。

## 后果

- 短暂网络故障不再因为随机措辞变化变成不变量错误，真实模型可以按默认配置恢复。
- EventLog 同时保留失败尝试、作废边界和最终输出，审计信息不因投影折叠而丢失。
- 默认模式可能消耗更多 token，Provider 请求仍是 at-least-once；Kernel 也不保证被作废文本没有被流式消费者提前看到。
- 严格前缀模式仍能尽早暴露回放或确定性 Provider 的分叉。

## 开放问题

1. 当前事件只表达单个连续 delta 区间，且不增加通用 attempt ID。跨多次进程崩溃的严格尝试预算和面向实时消费者的撤回协议仍需单独设计。
2. Provider 原生 continuation 或可恢复流游标若进入公共能力位图，是否可以在 `discard` 前优先续流，留待 Provider 契约扩展决定。
