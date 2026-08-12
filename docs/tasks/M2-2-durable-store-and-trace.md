# 任务 M2-2：持久化 EventLog（StorePort）+ TracePort

M2-1 补齐了权限、Sandbox 与 conformance 三块地基。本任务补最后两个 Port，然后 M2-3 就可以并行铺三家云适配器。

**为什么现在做 Store**：内核的全部价值主张——崩溃恢复、时间回溯、审计——目前只建立在内存 EventLog 上。进程一退什么都没有。同时用户明确要求支持后台 server 的分布式部署，ADR 0002 已经把问题列清楚但把实现推到了 M2。现在兑现。

开工前通读 `docs/adr/0002`、`docs/design.md` §2.2、§12。

## P0 — StorePort 与持久化 EventLog

1. **定义 `StorePort`**（design.md §2.2）：`kv` 与 `eventLog` 两个子 Port。EventLog 的接口语义已由 ADR 0002 定下，本任务把它变成真的：
   - `append(event, expectedLastSeq?)` 的比较与追加必须在**同一原子操作**内完成；冲突抛 `EventLogConflictError`。
   - `read(fromSeq)` 是包含性游标、可重复迭代的有限快照。
   - `subscribe` 仍只承诺单进程内投递；分布式消费走"游标 read + 至少一次"。
2. **三个实现**：SQLite（零配置默认，单机可用）、MySQL、Redis。SQLite 进 `providers/standard`，MySQL/Redis 同样在 `providers/standard` 下按 subpath 区分，重依赖走 peerDependencies。
3. **ADR 0002 的待决问题现在要给答案**，每条写进新 ADR：跨副本 seq 分配、并发写入仲裁、至少一次消费的游标语义、重复事件的幂等键、读取一致性级别。不要求全部实现，但要给出**本项目选定的方案**与理由。
4. **多写者并发测试是本任务的核心验收**：两个进程/连接同时向同一 session 追加，必须恰好一个成功、另一个拿到 `EventLogConflictError`，且事件流无空洞、无重复 seq。这个测试要在 SQLite 与 MySQL 上都跑（Redis 若语义不同，如实记录差异）。
5. **崩溃恢复要在持久化实现上重做一遍**：M1-2 的 coding 闭环测试改为可选跑在 SQLite 上，进程真的退出后重启续跑（不是同进程模拟中断）。

## P1 — TracePort（design.md §12）

1. 以 **OpenTelemetry GenAI 语义约定**为唯一内部标准，不为任何厂商单独设计埋点。
2. `TracePort` 接口 + 两个实现：`NoopTracer`（内核内置 Null Object）与 `providers/standard` 的 OTLP exporter（Langfuse/Jaeger/各云 APM 都只是配置）。
3. Span 树覆盖 turn / step / model call / tool call；Metrics 覆盖 token、成本、延迟、策略效果（M0-2 的 `StrategyMetrics` 要接进来，别浪费）。
4. 敏感信息：prompt 与工具参数默认**不进 trace**，需显式开启；开启后仍走 M1-1 已有的脱敏规则。

## P2 — conformance 扩卷

`oac conformance` 增加 `store` 与 `trace` 两卷，沿用 M2-1 已建立的诚实性检查思路：

- store 卷必须覆盖原子 CAS、游标可重复读、冲突语义；实现声明支持某一致性级别就要真的满足。
- 外部依赖不可用时（MySQL/Redis 未启动）**显式 skipped**，不得静默通过——沿用 Docker 那条已验证的做法。
- 能力矩阵自动更新。

## 约束与护栏

- **不做**：腾讯/阿里/火山适配器（M2-3）、VaultPort（M2-3 与凭证一起）、Runtime/Server、UI。
- kernel 保持零 runtime dependencies——数据库驱动只能出现在 provider 包的 peerDependencies。
- CI 不得强依赖 MySQL/Redis：可用时跑，不可用时显式跳过。SQLite 必须在 CI 中真跑（它是零配置默认）。
- **不要为了让测试通过而弱化 ADR 0002 的契约**。如果某个存储引擎无法满足原子 CAS，如实记录该实现的语义差异并在能力矩阵中体现，不要悄悄降级接口承诺。

## 验收

- 多写者并发冲突测试在 SQLite 与 MySQL 上通过；事件流无空洞无重复。
- 进程真实退出后从 SQLite 恢复续跑 coding 闭环。
- `oac conformance` 四卷（model/sandbox/store/trace）全绿或显式 skipped；说谎的 store 实现被判红。
- Trace 中默认看不到 prompt 与工具参数；显式开启后脱敏规则仍生效。
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm examples` 全绿。

## 顺带

真实模型闭环录制若拿到端点（`OAC_MODEL_BASE_URL` / `OAC_MODEL_NAME` / `OAC_RUN_LIVE=1`）就补录入库；拿不到继续显式标记未完成。

## 工作方式

新分支 `feat/m2-2-durable-store-and-trace`，小步 commit，PR 描述含 Decisions / Open Questions / 验收逐条勾选，并附 `git log --oneline` 与 head SHA。
