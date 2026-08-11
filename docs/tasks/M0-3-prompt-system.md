# 任务 M0-3：Prompt 系统 + 工具错误回喂 + 循环拆分

M0 的第三个纵切。M0-2 复审结论：AgentLoop / Strategy / Middleware 的机制骨架已经立住，无正确性缺陷需要返工。本任务做三件事——补齐 design.md §8 的 Prompt 系统，修一个会影响 Coding Agent 可用性的设计缺口，以及在文件继续膨胀前拆分主循环。

开工前通读 `docs/design.md` §8、`docs/adr/0003`，以及 PR #2 的 Decisions 与 Open Questions。

## P0 — 工具错误必须能回喂给模型

**问题**：当前工具异常只有两种归宿——`retry` 策略决定重试，或写入失败 `tool.result` 后**抛出并终止整个 turn**（`RetryDecision` 只有 `{retry, delayMs}` 两个字段，没有第三种选择）。

对 Coding Agent 而言这是致命的：编译报错、测试失败、文件不存在、命令退出码非零，都是**正常且高频**的工具结果，agent 应当看到错误、自行调整后重试或换路径。一失败就终止 turn 的 agent 在真实仓库里跑不了几步。M0-2 的 Decision #8 把这条定为刻意行为，但它只适合"基础设施故障"，不适合"工具正常返回了失败"。

**要求**：

1. 区分两类失败——**执行失败**（工具本身抛异常/超时/沙箱不可用，属基础设施问题）与**结果失败**（工具正常完成但业务结果是失败，如测试不通过）。后者本就该是普通的 `tool.result`，不应触发 retry 更不应终止 turn。工具接口需要能表达"我完成了，但结果是失败"，而不是只能靠抛异常。
2. `RetryDecision` 扩展第三种归宿：`'retry' | 'fail-turn' | 'feed-back'`。`feed-back` 表示写入失败 `tool.result` 后**继续循环**，让模型在下一步看到错误。
3. 默认策略调整为对执行失败重试有限次、耗尽后 `feed-back`（而非 `fail-turn`）；`fail-turn` 保留给显式配置与不可恢复错误。默认值的选择写进 ADR，因为它直接决定 agent 的行为气质。
4. 回归测试：工具连续失败两次后模型看到错误文本并在第三步改用另一个工具完成任务——这个测试就是"agent 能不能真的干活"的最小证明。

## P1 — Prompt 系统（design.md §8，本任务主体）

**纪律：内核代码中不允许出现写死的 prompt 字符串。** 实现后跑一遍全仓 grep 自查。

1. **PromptRegistry**：所有内置 prompt 有 ID、可枚举（`list()`）、可单独覆盖。至少覆盖 M0-2 已有的隐藏 prompt——prompted 工具协议的说明文本、压缩摘要 prompt、错误重试提示语；以及 `system.identity` / `system.tool-protocol` 等基础 slot。
2. **Slot 树（Composite）**：system prompt 按 `identity / capabilities / tool-protocol / project-context / skills / user-custom` 分段拼装，上游只覆盖某段，升级 SDK 不丢定制。覆盖必须支持"替换"与"追加"两种模式。
3. **来源与热更新**：内置默认 / 文件目录 / 运行时注入三种来源，带版本号；文件变更热加载（接口留好，文件监听可放 Runtime 层）。
4. **Context 组装管道显式化**：把 M0-2 中 `#assembleContext` 的隐式流程改为 design.md §8.3 的显式多阶段管道（history → memory 注入 → skill 注入 → compaction → slot 拼装 → middleware 终审），每阶段产物可检查。
5. **Dry-run 模式**：输出 `ContextAssembly` 报告——最终 messages 全文、每段来源（哪个 slot/策略产生）、逐段 token 数、发生过的降级。**这是上游调 prompt 的唯一显微镜，验收时我会重点看它的可读性**：给定一个装配好的 agent，一次调用就能拿到人类可读的完整报告。

## P2 — 拆分 agent-loop.ts

`packages/kernel/src/loop/agent-loop.ts` 已达 1671 行，是第二大文件（694 行）的 2.4 倍，且 M0-3 还要往里加 context 管道。趁现在按职责拆分（仍在 `loop/` 领域目录内，不新建包、不按模式命名）：建议 `agent-loop.ts`（骨架与编排）/ `step.ts`（单步执行与工具批次）/ `recovery.ts`（恢复与不完整调用处置）/ `context.ts`（组装管道，P1 新增）。**纯结构调整，不改行为**——拆分单独成一个 commit，且该 commit 前后测试集完全一致。

## 顺带处理的 Open Questions

从 PR #2 认领两条，其余留到 M1/M2：

- **模型流中途崩溃**当前保守判为 failed。本任务实现模型级 retry（复用 `retry` 策略，`operation: 'model'`）与部分 delta 的去重恢复；不做可恢复流协议。
- **`compacting` 瞬时状态**：确定只投影已完成的 `compaction.applied`，不引入 `compaction.started/finished`；把结论写进 spec/README 并删除 design.md 中相应的状态机描述歧义。

## 约束与护栏

- **不做**：真实 LLM/Sandbox 适配器、Skill 的完整加载机制（Prompt 侧留好 slot 即可）、MCP/A2A、CLI、Runtime。
- kernel 保持零 runtime dependencies；`packages/` 不新增成员。
- 预算硬上限（design.md §12 的 `stopReason: 'budget'`）本任务**不实现**，但 spec 里已有该取值，请在 `spec/README.md` 标注"预留，M1 实现"，避免被误认为已支持。

## 验收

- P0 的"失败两次后换路径完成"端到端测试通过；两类失败的区分有独立测试。
- `prompts.list()` 能枚举全部内置 prompt；全仓 grep 无写死 prompt 字符串（自查结果写进 PR）。
- Slot 局部覆盖（替换/追加）各有测试；覆盖后升级不丢定制的场景有测试。
- Dry-run 报告在 `examples/` 里有一个可运行示例，输出人类可读。
- 拆分 commit 前后测试集一致，行为无变化。
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm examples` 全绿。

## 工作方式

新分支 `feat/m0-3-prompt-system`，小步 commit，PR 描述含 Decisions / Open Questions / 验收逐条勾选。
