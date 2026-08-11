# ADR 0005：版本化 Prompt 与可检查的 Context 组装

- 状态：已采纳（2026-08-11）
- 目标里程碑：M0-3（Prompt 系统）

## 背景

Prompt 若散落在循环、Strategy 或 Adapter 中，上游无法枚举实际指令，也无法只覆盖其中一段。Context 组装若只返回最终 messages，则 Prompt 来源、Middleware 改写、能力降级与 token 构成均不可见，调试只能依赖 Provider 请求日志。

Kernel 还需要支持目录配置热更新，但不能引入文件监听等 Runtime 依赖。

## 决策

1. 所有内置 Prompt 通过 `PromptRegistry` 注册，具有稳定 ID 与版本号。自然语言 Prompt 只存放在内置 Prompt 源；循环只保留协议标识等机器可读字面量。
2. Prompt 源按 `builtin < directory < runtime` 的固定优先级合并。每个覆盖支持 `replace` 与 `append`；`replaceSource()` 原子替换整个来源，供 Runtime 的目录监听器热加载。一次 Context 组装先取得 Registry snapshot，避免热更新导致同一请求混用两个版本。
3. System Prompt 采用固定 slot 顺序：`identity / capabilities / tool-protocol / project-context / skills / user-custom`。每个 slot 独立解析，使 SDK 内置 Prompt 升级时保留其他来源的局部定制。
4. Context 管道固定为 `history → memory → skills → compaction → slots → context-middleware → model-middleware`。每阶段保存 messages、segment ID、状态与 token 信息；M0-3 的 Skill 加载阶段只保留显式 `noop` 与 `system.skills` slot。
5. `AgentLoop.dryRunContext()` 运行相同的 Context 与 Model Middleware，并以 `mode: 'dry-run'` 标记调用。Kernel 不写事件、不消费 Steering，也不调用 `ModelPort.stream()`；只使用 `countTokens()` 计算逐段与完整请求 token 数。
6. `model.request.assembled` 顶层继续保留 `messages`、`tools`、`toolUse` 与 `metadata`，同时记录阶段、segment、Prompt revision 与能力降级。恢复流程只读取请求字段并忽略报告扩展字段，从而复用原始请求。
7. `compaction.applied.strategy` 以向后兼容的可选字段记录生成摘要的 Strategy 名。旧事件没有该字段时，报告只标识事件序号，不根据当前配置猜测来源。

## 后果

- `prompts.list()` 可以枚举全部有效 Prompt；每个 segment 可以追溯到 Prompt ID、来源、来源版本、Prompt 版本与覆盖模式。
- Runtime 可以通过原子替换 `directory` 来源实现文件热更新，Kernel 保持零 runtime dependencies。
- Dry-run 的完整请求 token 数由 ModelPort 计算。逐段 token 数分别计算，受分词边界与请求包装影响，各段之和不保证等于完整请求 token 数。
- Middleware 在 dry-run 中仍可能执行自身的外部逻辑；`mode` 是避免外部副作用的契约信号，Kernel 只能保证自身不写 EventLog、不启动模型流。

## 本 ADR 不决定

- 不实现目录监听、远端配置中心或 Prompt 实验分流；这些能力属于 Runtime。
- 不实现完整 Skill loader；M0-3 只保留阶段与 slot。
- 不定义跨 Provider 可比的 token 归因算法或 dry-run 计费规则。
