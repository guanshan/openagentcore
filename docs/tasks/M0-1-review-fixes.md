# 任务 M0-1R：Review 修复 + EventLog 分布式契约收紧

M0-1 的 review 结论（2026-08-11，10 条 findings，多数经执行验证）。在 `feat/m0-1-bootstrap` 分支上继续修复，按优先级从上到下做完；每条修复必须带复现该缺陷的回归测试。

## P0 — 正确性缺陷（执行确认）

1. **projection.ts:278 折叠 summary 位置错乱**：compaction 折叠先前 summary 时经 `Math.min` 继承旧 `positionSeq`，把覆盖较晚事件的摘要排到更早的保留消息之前，`representedRanges` 出现跨越保留消息的不连续区间。复现序列：delta 0-4 → compaction 5 折叠 0..1 → delta 6 → compaction 7 折叠 5..6。需要先明确语义（建议：摘要按其覆盖区间的**最大** seq 定位，保持时间序），把语义写进 spec/README，再实现。
2. **projection.ts:354 覆盖区间记账丢失**：`materializeEntry` 只暴露最近一次 compaction 的 dropped 区间、丢弃 `representedRanges`——被折叠摘要覆盖的原始事件在物化历史中无迹可寻。物化结果应携带完整 `representedRanges`。
3. **projection.ts:159 未知事件类型静默损坏状态**：switch 无 default，运行时遇到未知 `type`（如新版本 spec 的 trajectory JSON）返回 undefined，在远处崩溃。default 分支抛 `ProjectionInvariantError`，写明未知类型与 seq；TS 侧用 `never` 穷尽检查保住编译期。
4. **agent-event.v0.json:89 eventRange 无有序性约束**：`{fromSeq:9, toSeq:3}` 过 schema 也过 append，但重放必炸——与 README"accepted 即满足流不变量"矛盾。JSON Schema 2020-12 无法表达跨字段比较，因此：README 判定升级为三步（schema-accepted / append-accepted / **replay-accepted**），区间有序性归入 replay 级校验，并新增一类 `invalid-replay-*.json` 向量（含倒序区间、引用未来 seq）。

## P1 — 契约与 CI 盲区

5. **event-log.ts:82 read() 一次性迭代器**：返回值二次迭代静默得空。改为每次 `[Symbol.asyncIterator]()` 产生新迭代器（返回可重复迭代对象），并在接口注释写明语义；补二次迭代回归测试。
6. **EventLog 分布式契约（新增）**：本 SDK 要支撑后台 server 多副本部署，MySQL/Redis 等分布式 EventLog 实现不能被接口形状堵死。本任务做最小收紧：
   - `append` 增加可选 `expectedLastSeq` 参数（乐观并发控制）：不匹配时抛 `EventLogConflictError`。InMemory 实现之，接口语义写进注释与 spec/README。
   - `subscribe` 在接口注释中明确为**单进程内的便利机制**，不承诺跨进程投递；分布式消费的正规路径是"从 seq 游标 read + 至少一次"语义。订阅者异常的既定策略（隔离、不中断 append）保持，但补充可选 `onSubscriberError` 回调，不再完全静默。
   - 跨副本 seq 分配、租约/单写者、至少一次投递的完整设计**不在本任务展开**——起草 `docs/adr/0002-eventlog-distributed-contract.md`（status: proposed）列出问题与候选方案即可，实现放 M2（Store providers）。
7. **depcruise 盲区两处**：bare specifier 导入（`import '@openagentcore/replay-demo'`）零违规——补 `doNotFollow`/resolve 配置或等价手段使其可见，并加一条"故意违规必须变红"的自检测试；`lint:boundaries` 的 CLI 路径补上 `providers`（配置里的正则目前是死代码）。
8. **prettier 检查改为 `prettier --check .` + `.prettierignore`**（对齐 eslint 已有模式），移除 `--no-error-on-unmatched-pattern`；顺手把当前未格式化的 README.md、docs/design.md 格式化掉（单独 commit，避免混入逻辑变更）。
9. **schema.test.ts:54 向量 runner**：向量文件增加显式的流身份声明字段（如顶层 `stream: {tenantId, sessionId}`），runner 不再从首事件推导——使"首事件即违规"的用例可表达；格式变更同步 spec/README。

## P2 — 清理（cleanup agent 结论）

10. `collect` 助手在两个测试文件间复制——移入 `schema.test-support.ts`。
11. schema.test.ts 重复搭建 Ajv——从 test-support 导出配置好的实例/工厂。
12. `positionSeq` 是冗余状态（恒等于 `representedRanges[0].fromSeq`）——随 P0-1 的语义修正一并处理（若新语义仍需要位置字段，必须由 representedRanges 推导，不做双份状态）。
13. `projectMessageHistory` 每事件全量复制 entries 数组，重放 O(n²)——内部用可变数组累积、结束时冻结；公共 API 不可变性不变。这是重放路径，正是快照+重放设计要服务的负载。
14. replay-demo 的 `lastSeq: 2` 硬编码——改为 `head.at(-1)!.seq` 推导。

## 验收

- 每条 P0/P1 有对应回归测试；新 `invalid-replay-*` 向量 ≥2 条；补"未声明字段拒绝"与"空字符串 tenantId/sessionId 拒绝"向量各 1 条（review 发现 schema 已强制但零向量覆盖）。
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿；格式化 commit 与逻辑 commit 分离。
- PR 描述更新：逐条对照本文件勾选，语义变更（P0-1、P1-6、P1-9）在 Decisions 中说明。
