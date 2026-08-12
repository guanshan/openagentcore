# ADR 0011：持久化 Store、分布式 EventLog 与 TracePort

- 状态：已采纳（2026-08-12）
- 目标里程碑：M2-2（Durable Store 与 Trace）
- 延续：[ADR 0002](0002-eventlog-distributed-contract.md)

## 背景

ADR 0002 固定了 EventLog 的原子 CAS、包含性有限快照和进程内订阅契约，但有意没有选择跨副本 `seq`、并发仲裁、消费游标、幂等和读取一致性方案。M2-2 需要让崩溃恢复第一次建立在共享持久化存储上，同时保持 Kernel 零 runtime dependency，并给后续云 Provider 一套可以由 conformance 验证的明确语义。

可观测性同样必须停在 Port 边界：Kernel 只表达 OpenTelemetry GenAI 的 span、attribute 和 metric，不依赖 OpenTelemetry SDK；Exporter、协议和部署配置属于 Provider。

## 决策

### StorePort 与 EventLog

1. Kernel 定义 `StorePort`，包含 byte-native `KvPort` 与按 `EventStreamIdentity` 打开的 `EventLogPort`。持久化 Provider 声明 `atomicCas`、`sequence`、`readConsistency` 和 `durability` 能力；声明与 conformance 结果不符即判红。
2. **跨副本 `seq` 分配**选择每个流一条原子 head 记录，不采用租约、号段或单写者。调用方提交的 `event.seq` 必须等于事务中观察到的 `head + 1`；SQLite/MySQL 在数据库事务内锁定并更新 head，Redis 在同一 Lua 脚本内比较 head、写事件并推进 head。标准持久化实现因此不跳号。基础 `EventLog` 接口仍允许只保证严格单调的实现，以兼容已有内存实现与外部事件导入；能力矩阵会明确两者差异。
3. **并发写入仲裁**只使用 `expectedLastSeq` 乐观 CAS。冲突立即返回 `EventLogConflictError`，不在 Adapter 内排队、重试或改写事件。未提供 expected 值的 append 仍为公共接口兼容能力，但 AgentLoop 和多写者生产路径必须提供它；公平性由调用方的 retry/backoff 策略决定。
4. **至少一次消费**选择消费者独立持久化 next-unread 游标。消费者调用包含性的 `read(cursor)`，完成副作用后才把游标推进到 `event.seq + 1`；在副作用与游标提交之间崩溃会重复处理当前事件。M2-2 不内置消费组、后台投递或消息总线。
5. **重复事件处理**选择消费者以 `(tenantId, sessionId, seq)` 为稳定幂等键。追加侧暂不增加独立幂等键，因为当前 AgentEvent schema 没有跨重试稳定的 event id；在没有 retention 与唯一性生命周期方案前，不用隐式 payload hash 代替协议字段。
6. **读取一致性**选择 primary 强一致。`read(fromSeq)` 在调用时观察一次流 head，并只返回不超过该 head 的有限快照；同一返回值可重复迭代。MySQL 必须走 primary 连接，Redis 必须走 primary client，读副本不属于本能力声明。未来若开放 eventual/replica read，必须新增显式一致性能力和降级事实，不能沿用 `strong-primary` 标签。
7. SQLite 是零配置默认，使用 Node 内置 SQLite；MySQL 与 Redis 驱动只列在 `@openagentcore/standard` 的可选 peer dependencies，并延迟加载。三个 Adapter 均在进程内实现 `subscribe`，不会把数据库通知、Redis Pub/Sub 或轮询伪装成跨副本订阅。
8. SQLite 与 MySQL 的已确认事务提交提供持久化；Redis 的原子可见性不等于掉电持久性，其 `durability` 声明为 `deployment-configured`。Redis 是否在 failover 后保留已确认写入取决于 AOF、复制和等待策略，能力矩阵必须保留这项差异。

### TracePort

9. Kernel 定义 provider-neutral `TracePort`、span/metric 数据结构和 `NoopTracer` Null Object。AgentLoop 显式产生 turn → step → model/tool span 树，并记录 token、成本、延迟与 Strategy 指标；Kernel 不导入 OpenTelemetry 包，也不依赖 ambient async context。
10. GenAI operation 使用 OpenTelemetry 约定值：turn 为 `invoke_agent`、模型调用为 `chat`、工具调用为 `execute_tool`。token 使用 `gen_ai.client.token.usage` 与 `gen_ai.token.type`；尚无稳定标准名的成本和 Strategy 指标使用 `openagentcore.*` 命名并标为项目扩展。
11. prompt、模型输出和工具参数属于 opt-in 内容，默认不写 trace。显式开启内容采集时，Provider 必须先复用模型 Record & Replay 的敏感 key、凭证文本和额外 key 脱敏规则，再序列化为 attribute；Exporter 不接受绕过脱敏的原始内容选项。
12. `@openagentcore/standard` 提供 OTLP/HTTP Adapter。endpoint、headers、resource attributes 和 flush 生命周期是 Provider 配置；Langfuse、Jaeger 与各云 APM 只要接收 OTLP 就不产生新的 Kernel 埋点模型。

## 后果

- 同一 session 的竞争写入由存储原子原语裁决；失败写入既不占 `seq` 也不通知订阅者，恢复可以依赖无空洞的标准持久化流。
- 至少一次语义把重复处理责任明确留给消费者；这比承诺无法跨数据库统一兑现的 exactly-once 更诚实。
- primary 强一致牺牲读副本扩展性，但让恢复、审计和 conformance 有单一可移植基线。以后增加弱一致读取需要公开能力变化。
- Redis 可满足原子 CAS 与强 primary read，但其灾难持久性是部署属性；调用方不能仅凭 `append` 成功推断已同步到副本或磁盘。
- 手工传递 span parent 比依赖 SDK ambient context 更显式，也让 Kernel 保持零依赖；Provider 负责把 portable 数据映射到 OTLP。

## 开放问题

1. 追加侧幂等键的 schema、保留周期和唯一索引成本需要真实重复提交数据后再决定。
2. 消费者游标是否应进入 `KvPort` 的带版本 CAS、独立 CursorPort 或外部消息系统，留待后台投递任务设计。
3. Redis 是否增加可配置 `WAIT`/`WAITAOF` durability 等级，以及这些等级如何跨托管服务协商，留待 M2-3 Provider 数据。
4. OpenTelemetry GenAI 约定仍在演进；稳定版本、schema URL 与内容事件格式确定后，OTLP Adapter 需要版本化能力而不是静默改名。
