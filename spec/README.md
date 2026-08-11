# spec（L0）

语言无关的协议定义：事件流、工具 Schema、Trajectory 格式、UI 线协议（JSON Schema），以及 conformance 测试向量。

本目录独立发版；Python 仓按版本号锁定拉取。TypeScript 实现为参考实现，先行半个版本。

## Schema 版本与 `$id`

- spec 发行版本使用 SemVer，首个版本为 `0.1.0`。
- Schema 文件名使用 `<name>.v<major>.json`；`v0` 表示当前实验性契约代际，不等同于 spec 发行版本。
- Schema 的规范 `$id` 为 `https://openagentcore.dev/spec/schemas/<filename>`，与仓库文件名一一对应。
- 当前 Schema 使用 JSON Schema 2020-12；顶层协议对象默认封闭，未声明字段会被拒绝。
- Schema 文件一经随 spec 发版，其 `$id` 与语义保持不变；不兼容变更新增下一代文件。

## AgentEvent v0

`agent-event.v0.json` 定义 design.md §4.1 的 10 种事件。每个事件都包含以下公共字段：

| 字段        | 约束                        |
| ----------- | --------------------------- |
| `type`      | 事件判别字段                |
| `seq`       | 大于或等于 0 的整数         |
| `tenantId`  | 非空租户 ID                 |
| `sessionId` | 非空会话 ID                 |
| `ts`        | RFC 3339 `date-time` 字符串 |

`tenantId` 对应 design.md §10 的持久化租户身份要求。L0 JSON 字段沿用 `sessionId`、`turnId` 等字段的 camelCase 约定；数据库列名不属于本协议。

单个 EventLog 表示一个租户下的单个 Session。流内 `seq` 必须严格递增，但允许跳号；`read(fromSeq)` 的起点包含 `fromSeq`。JSON Schema 只校验单个事件的结构，跨事件的租户、会话和顺序不变量由实现及一致性测试向量校验。

本代际对 design.md §4.1 中尚未展开的类型采用以下最小定义：

- `UserInput` 是带字符串 `content` 的封闭对象。
- `ContextAssembly` 与 `ActionDescriptor` 保留为 JSON 对象，具体字段由后续对应模块定义。
- `TextOrToolDelta` 分为 `{ kind: "text", text }` 与 `{ kind: "tool", toolCallDelta }`；工具增量暂保留为任意 JSON 值。
- `ToolResult`、工具 `args` 是任意 JSON 值，不接受 `undefined`、函数等非 JSON 数据。
- `EventRange` 使用包含端点的 `fromSeq` 与 `toSeq`。
- `StopReason` 当前只约束为非空字符串；正式枚举留待 AgentLoop 契约定义。

## Trajectory v0

`trajectory.v0.json` 包含 `metadata` 与 `events`。`metadata.specVersion` 使用完整 SemVer，并记录 `tenantId`、`sessionId` 与非空的 `agentDefinitionSummary`。具体支持版本由消费者的 spec 版本锁判断。空事件流合法；非空事件流必须与元数据属于同一租户和会话，该跨项约束由一致性测试实现。

## 一致性测试向量

`vectors/*.json` 均为手写样例，格式如下：

```json
{
  "description": "样例说明",
  "expected": "accepted",
  "events": []
}
```

`expected` 只能是以下三种结果：

- `accepted`：事件结构与事件流不变量均合法。
- `schema-rejected`：至少一个事件不符合 AgentEvent Schema。
- `append-rejected`：事件结构合法，但事件流不变量不成立。

判定分两步：

1. 每个事件必须通过 `agent-event.v0.json`。
2. 整条流必须属于同一租户和会话，且 `seq` 严格递增。

参考实现的测试自动发现并消费本目录下的全部 JSON 文件。

## 外部协议版本锁定

采标不自造（design.md §2.3）。本目录记录各外部协议的锁定版本，升级走 ADR：

| 协议  | 锁定版本                                       |
| ----- | ---------------------------------------------- |
| MCP   | 2026-07-28                                     |
| A2A   | v1.0                                           |
| AG-UI | 跟随主线，`oac.*` 扩展事件 Schema 在本目录定义 |
