# ADR 0006：模型流重试与持久化前缀去重

- 状态：部分被 [ADR 0008](0008-divergent-model-stream-retries.md) 取代（2026-08-11）
- 目标里程碑：M0-3（Prompt 系统）

## 背景

> ADR 0008 将第 4–6 条的严格前缀语义降为显式可选模式；真实模型默认采用可审计的作废重来。本文保留为严格模式及历史决策记录。

模型流可能在已经写入部分 `model.delta` 后中断。直接重试会重复持久化文本或工具调用；直接判定 step 失败则无法从短暂 Provider 故障恢复。进程崩溃后重新组装 Context 还会把已持久化的部分 assistant 文本加入新请求，使恢复请求偏离原请求。

## 决策

1. 一次模型尝试包含 `countTokens()` 与一个新 stream，并共享同一份 `operation: 'model'` 重试预算。默认最多尝试 2 次，耗尽后执行 `fail-turn`。
2. 只有 `ModelPort.countTokens()` 与 stream iterator 的 `next()` 异常按 Provider 故障进入 Retry Strategy。Middleware、事件持久化、去重校验、Retry Strategy 与等待逻辑的异常不重试；进程崩溃测试信号与 abort 直接传播。
3. 同一步的所有尝试只写入一个 `model.request`，并复用同一个 `requestId`。每次重试重新发送完全相同的 `ModelRequest`。
4. 已持久化 delta 构成 canonical prefix。文本按 Unicode code point 连续匹配，允许 Provider 在重试时改变 chunk 边界；工具调用按 `callId`、工具名与完整 JSON 参数作为不可拆分原子匹配。匹配的前缀不重复写入，新增后缀继续持久化。
5. 重试输出与 canonical prefix 内容或类型不一致，或成功结束时尚未完整重放前缀，均视为不变量错误并立即失败，不进入下一次重试。
6. 进程恢复时，若活动 step 尚无 `tool.call`，从持久化 `model.request.assembled` 还原原请求，并用已有 delta 初始化 canonical prefix。恢复不重新运行 Context 组装；Model Middleware 即使再次执行，也不能改写实际发送的持久化请求。
7. 已存在 `tool.call` 时，模型阶段视为完成，继续采用 [ADR 0003](0003-incomplete-tool-call-recovery.md) 的工具恢复流程。

## 后果

- 短暂模型故障可以恢复，文本与工具副作用不会因重复 delta 在 Kernel 内重复执行。
- Provider 请求仍是 at-least-once；Kernel 不保证模型服务只处理一次请求。
- 工具调用的去重采用完整结构比较，不会仅凭 `callId` 掩盖参数分叉。

## 本 ADR 不决定

- 不定义 Provider 原生的可恢复流游标或跨请求 continuation 协议。
- 不把模型 attempt marker 写入事件。跨多次进程崩溃严格累计重试预算留待后续恢复协议处理。
- Model Middleware 的 `chunks` 当前保留各次尝试产生的原始 chunk；持久化事件与消息投影只包含去重后的 canonical 输出。
