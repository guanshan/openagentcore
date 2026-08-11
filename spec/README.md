# spec（L0）

语言无关的协议定义：事件流、工具 Schema、Trajectory 格式、UI 线协议（JSON Schema），以及 conformance 测试向量。

本目录独立发版；Python 仓按版本号锁定拉取。TypeScript 实现为参考实现，先行半个版本。

## Schema 版本与 `$id`

- spec 发行版本使用 SemVer，首个版本为 `0.1.0`；本次向后兼容增补后的版本为 `0.2.0`。
- Schema 文件名使用 `<name>.v<major>.json`；`v0` 表示当前实验性契约代际，不等同于 spec 发行版本。
- Schema 的规范 `$id` 为 `https://openagentcore.dev/spec/schemas/<filename>`，与仓库文件名一一对应。
- 当前 Schema 使用 JSON Schema 2020-12；顶层协议对象默认封闭，未声明字段会被拒绝。
- `$id` 标识 Schema 契约代际，精确内容由 spec 发行版本锁定。使用方必须锁定发行版本，不应把 `$id` URL 当作不可变制品地址。

同一 Schema 代际只保证新 reader 接受旧数据，不保证旧 reader 能识别新增事件。版本判定规则如下：

- 增加事件变体、可选字段或扩大既有字段的合法取值属于向后兼容增补，保持文件名中的代际号并提升 spec minor 版本。
- 只修正文档或测试、且不改变任何 Schema 与 replay 判定的变更提升 patch 版本。
- 删除或重命名字段、把可选字段改为必填、收窄合法取值、改变既有字段语义，或让已有 accepted conformance 向量变为 rejected，均属于破坏性变更。此类变更新增下一代 Schema 文件并提升 spec major 版本。
- 对此前未定义、且没有 accepted conformance 向量承诺的非法时序补充 replay 不变量，视为语义补全。新增向量从引入它的 spec 发行版本起生效。

## AgentEvent v0

`agent-event.v0.json` 定义 12 种事件，其中 `step.started` 与 `step.finished` 在 M0-2 加入。每个事件都包含以下公共字段：

| 字段        | 约束                        |
| ----------- | --------------------------- |
| `type`      | 事件判别字段                |
| `seq`       | 大于或等于 0 的整数         |
| `tenantId`  | 非空租户 ID                 |
| `sessionId` | 非空会话 ID                 |
| `ts`        | RFC 3339 `date-time` 字符串 |

`tenantId` 对应 design.md §10 的持久化租户身份要求。L0 JSON 字段沿用 `sessionId`、`turnId` 等字段的 camelCase 约定；数据库列名不属于本协议。

单个 EventLog 表示一个租户下的单个 Session。流内 `seq` 必须严格递增，但允许跳号；`read(fromSeq)` 的起点包含 `fromSeq`，返回可重复迭代的有限快照。`append(event, expectedLastSeq?)` 可用当前流头做原子乐观并发检查，空流的流头是 `-1`，不匹配时不得写入。JSON Schema 只校验单个事件的结构，跨事件的租户、会话和顺序不变量由实现及一致性测试向量校验。

`subscribe` 只是在单进程内观察未来 append 的便利机制，不承诺跨进程投递。同步异常与异步 rejection 都必须和 append 隔离并通过可选错误回调上报；append 不等待订阅者完成。分布式消费者应持久化 `seq` 游标，通过 `read` 重试并按至少一次语义处理事件；跨副本 seq 分配、租约或单写者策略留待 Store provider 设计。

本代际对 design.md §4.1 中尚未展开的类型采用以下最小定义：

- `UserInput` 是带字符串 `content` 的封闭对象。
- `ContextAssembly` 与 `ActionDescriptor` 保留为 JSON 对象，具体字段由后续对应模块定义。
- `TextOrToolDelta` 分为 `{ kind: "text", text }` 与 `{ kind: "tool", toolCallDelta }`；工具增量暂保留为任意 JSON 值。
- `ToolResult`、工具 `args` 是任意 JSON 值，不接受 `undefined`、函数等非 JSON 数据。
- `EventRange` 使用包含端点的 `fromSeq` 与 `toSeq`，并满足 `0 <= fromSeq <= toSeq < compaction event seq`。跨字段大小关系由投影语义校验。
- `StopReason` 当前只约束为非空字符串；正式枚举留待 AgentLoop 契约定义。

AgentLoop 事件使用以下关联与记账字段：

- `step.started` 必须包含 `turnId`、`stepId`、从 1 开始的 `stepIndex`，以及本步消费的 `injectedInputs`。`injectedInputs` 是可为空的 `UserInput` 数组；每一项都进入消息历史投影，使 Steering 可以在恢复后重建。
- `step.finished` 必须与活动 step 匹配，并包含 `outcome` 与 `usage`。`outcome` 为 `succeeded`、`failed` 或 `aborted`。`succeeded` 表示 step 的控制流程完整结束，不表示其中每个工具的业务结果都成功。
- `usage` 必须包含非负整数 `inputTokens`、`outputTokens` 与 `totalTokens`；可选 `cost` 使用非负 `amount` 和非空 `currency`。`turn.finished.usage` 是各步用量的累计值。
- `model.request.toolUse` 记录实际采用的工具调用模式。值为 `prompted` 时表示已使用文本协议降级；`capabilityDowngrades` 记录可读的降级说明。
- `requestId`、工具与审批事件上的 `stepId` / `callId` 用于跨事件关联。它们对 M0-1 数据保持可选，M0-2 AgentLoop 产生的新事件应完整填写。
- `tool.call.modelUsage` 在工具副作用前复制已完成模型调用的用量。恢复流程用它补写 `step.finished.usage`；旧事件可不包含该字段。
- `tool.result.outcome` 为 `succeeded`、`failed` 或 `denied`；`attempts` 从 1 开始。既有 `result` 字段保持必填和开放 JSON 值，以便读取 M0-1 数据。`failed` 且不含 `error` 表示工具正常完成后的结果失败；同时包含 `error` 表示工具执行失败。

### AgentLoop replay 不变量

Session 状态由事件流投影，不单独持久化。replay 至少执行以下检查：

- 同一 Session 最多有一个活动 turn；`turn.finished` 必须匹配活动 turn，且不能越过活动 step 或未完成工作。
- `step.started` 必须属于活动 turn；同一时刻最多有一个活动 step，`stepIndex` 在 turn 内严格递增；`step.finished` 必须匹配活动 step。
- 使用 `step.*` 的 turn 中，模型、工具与审批事件必须属于当前活动 step。没有 `step.*` 的 M0-1 流继续按 legacy 规则读取。
- `tool.result` 必须匹配更早的 `tool.call`，同一 `callId` 最多产生一个结果。
- `permission.resolved` 必须匹配更早的 `permission.requested`，同一 `reqId` 最多解决一次；关联字段同时存在时必须一致。
- 工具调用、审批、turn 或 step 可以在流尾保持未完成。这样的事件流是合法恢复前缀，不因缺少后续结束事件而拒绝。

流尾存在 `tool.call` 但没有 `tool.result` 时，只能断定调用结果未知。恢复策略可以重试或写入失败结果；副作用与幂等语义由 AgentLoop 恢复 ADR 规定。

Compaction 只折叠消息投影，不删除 EventLog 中的原始事件。摘要分别记录 `contentRanges` 与 `compactionSeqs`：`contentRanges` 只包含被折叠且实际产生消息投影条目的内容事件，`compactionSeqs` 只包含被折叠的旧 `compaction.applied` 事件序号。显式折叠或替换旧摘要时，新摘要继承其两类记录，并把旧摘要自身的事件序号加入 `compactionSeqs`，但不得把这些元事件序号混入内容覆盖。物化摘要中的 `dropped` 仍是最近一次 `compaction.applied` 声明的原始区间，不表示完整内容覆盖。仍使用旧 `representedRanges` 的快照无法无损区分内容与元事件，恢复时必须拒绝该快照并从 EventLog 完整重放。

一次 compaction 的有效内容覆盖必须非空，并在消息投影中构成一个连续块；不产生消息投影条目的事件不形成内容间隔，被折叠的 compaction 元事件也视为透明。若两个被覆盖的内容条目之间仍有保留的内容或摘要，重放必须抛出投影不变量错误。重复或扩大已摘要的完整内容区间会替换旧摘要；只与现有摘要内容区间部分重叠的事件流同样会被拒绝。

摘要位置只按 `contentRanges` 中最大的 `toSeq` 推导，物化摘要也只公开完整的 `contentRanges`；`compactionSeqs` 不参与定位或物化。因此，折叠旧摘要本身不会把新摘要移到较晚的保留内容之后，也不会让摘要两侧原本分离的消息片段重新合并。

## Trajectory v0

`trajectory.v0.json` 包含 `metadata` 与 `events`。`metadata.specVersion` 使用完整 SemVer，并记录 `tenantId`、`sessionId` 与非空的 `agentDefinitionSummary`。具体支持版本由消费者的 spec 版本锁判断。空事件流合法；非空事件流必须与元数据属于同一租户和会话。JSON Schema 无法表达该跨项相等约束，一致性测试实现必须另行校验。

## 一致性测试向量

`vectors/*.json` 均为手写样例，格式如下：

```json
{
  "description": "样例说明",
  "stream": {
    "tenantId": "tenant-demo",
    "sessionId": "session-demo"
  },
  "expected": "accepted",
  "events": []
}
```

`stream` 是一致性测试夹具中 EventLog 的权威身份，用于表达首事件即违反租户或会话边界的用例；它不是 AgentEvent、Trajectory 或其他 wire Schema 的字段。

`expected` 只能是以下四种结果：

- `accepted`：事件结构、事件流和重放不变量均合法。
- `schema-rejected`：至少一个事件不符合 AgentEvent Schema。
- `append-rejected`：事件结构合法，但事件流不变量不成立。
- `replay-rejected`：事件结构与事件流合法，但 Session 状态或消息历史投影的重放不变量不成立。

判定分三步，前一步拒绝后不再运行后续步骤：

1. 每个事件必须通过 `agent-event.v0.json`。
2. 整条流必须与 `stream` 声明属于同一租户和会话，且 `seq` 严格递增。
3. 整条流必须可以确定性重放 Session 状态与消息历史投影。AgentLoop 时序、`EventRange` 的有序性，以及不得引用当前 compaction 事件或未来事件，均在此阶段校验。

一致性测试运行器必须启用 JSON Schema 标准 format 的断言语义，确保 `date-time` 不是仅作注解。编译 `trajectory.v0.json` 前，必须先按 `$id` 注册 `agent-event.v0.json`，或提供等价的 Schema resolver。

参考实现的测试自动发现并消费本目录下的全部 JSON 文件。

## 外部协议版本锁定

采标不自造（design.md §2.3）。本目录记录各外部协议的锁定版本，升级走 ADR：

| 协议  | 锁定版本                                       |
| ----- | ---------------------------------------------- |
| MCP   | 2026-07-28                                     |
| A2A   | v1.0                                           |
| AG-UI | 跟随主线，`oac.*` 扩展事件 Schema 在本目录定义 |
