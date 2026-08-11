# 任务 M1-1：接上第一个真实模型 + Record & Replay + 组合根

M0 的三个纵切已经把内核机制立齐（事件溯源、Strategy/Middleware、Prompt/Context）。但**内核至今没有见过一个真实模型**——所有测试都跑在 `ScriptedModelPort` 上。能力协商、流式解析、工具调用格式、错误形态这些最容易在真实环境翻车的地方，目前是零验证。本任务的目标是让内核第一次接上真实基建，并建立"接真实基建但不烧钱、不依赖网络"的测试能力。

开工前通读 `docs/design.md` §2.3、§7、§13.2、§14。

## 1. providers/standard —— OpenAI-compatible 适配器（本任务的主体）

一个 adapter 通吃 LiteLLM / OneAPI / Ollama / vLLM / 各云的兼容端点，是覆盖面最高的第一个 provider（design.md §7.4）。

- 包名 `@openagentcore/standard`，Port 用 subpath export：`@openagentcore/standard/model`。依赖走 peerDependencies，kernel 依旧零依赖。
- 实现 `ModelPort`：流式（SSE 解析）、原生工具调用、`countTokens`、取消（`AbortSignal` 必须真正中断 HTTP 请求，不是丢弃响应）。
- **能力协商要诚实**：`capabilities` 按实际端点探测或配置声明；不支持原生工具调用的端点必须如实声明 `toolUse: 'prompted'`，让内核走已实现的降级路径。
- 错误映射：把 HTTP 429/5xx/超时/内容过滤映射为内核可识别的错误类型，供 `retry` 策略区分对待——**这决定了重试策略能不能做对**。限流响应里的 `Retry-After` 要被尊重。
- 不要为任何单一厂商写特例分支；厂商差异用配置表达。真正无法用配置抹平的差异，记录在包 README 的兼容性说明里。

## 2. Record & Replay（design.md §13.2）

没有它，接真实模型之后每次跑测试都要花钱且结果不确定。

- **录制**：把 Port 层的真实交互（请求、流式响应分片、时序、错误）落入事件流或独立录制文件，格式在 `spec/` 定义。
- **回放**：`ReplayModelPort` 从录制确定性重放，不打真实 API。回放模式下整个 turn 的事件流应与原始运行逐字段一致（除时间戳等显式豁免字段）——这个一致性本身就是最强的回归测试。
- 敏感信息：录制默认脱敏 API key 与 Authorization 头；脱敏规则可配置。
- CLI 入口可以缓后，但录制/回放的编程接口本任务必须可用。

## 3. 组合根：Builder + Preset（design.md §7.2）

目前装配一个 agent 要手工 new 一堆东西。本任务建立正式入口：

- `AgentBuilder`：流式 API，`build()` 时做配置校验与能力协商，校验失败要给出指明层级与键路径的错误信息。
- `preset: 'oss-local'`：OpenAI-compatible 模型（指向本地 Ollama/vLLM 或任意兼容端点）+ 内存 Store + 本地进程执行 + Noop Tracer。**零外部依赖即可跑通**是这个 preset 的验收标准。
- 分层配置（design.md §14）：内置默认 < preset < 配置文件 < 环境变量 < 代码显式传参，每层可局部覆盖。
- `createAgent()` 顶层 Facade：三行代码跑通一个 agent。

## 4. 小修：工具契约违反的诊断

M0-3 把 `ToolExecutionResult` 改成了 `{outcome, result}` 判别联合（正确的设计）。但工具返回不符合契约的值时（JS 调用方无类型检查、或 MCP/远程工具适配器未归一化），报错是 `ProjectionInvariantError: Tool-result projection entry at index 2 is malformed`——不指明是哪个工具、也不说明哪里不对。

在 `invokeTool` 返回处校验形状，报错指明工具名与期望形状（如 `Tool "bad" must return { outcome, result }, received object without "outcome"`）。这类错误是契约违反，不应进入 retry 路径。

## 约束与护栏

- **不做**：Coding 工具集（M1-2）、Sandbox provider、腾讯/阿里/火山适配器（M2）、Runtime/Server、UI。
- kernel 保持零 runtime dependencies；`providers/` 是唯一生长轴，新 provider 必须能跑 conformance。
- 真实网络调用**不得进入 CI**：CI 只跑回放与 mock；真实端点测试单独标记，本地手动执行。
- 本任务会第一次暴露"内核假设 vs 真实模型行为"的差距。**发现的差距要如实记录**（PR 的 Open Questions 或 ADR），不要在 provider 里悄悄打补丁绕过内核的问题。

## 验收

- 用 `preset: 'oss-local'` 指向一个本地兼容端点，跑通一个真实的多步 turn（含工具调用），录制之；回放该录制，事件流逐字段一致。
- 能力降级路径在真实 `toolUse: 'prompted'` 端点上验证过一次（可用本地小模型）。
- 限流/超时/5xx 三类错误各有映射测试（用 mock server，不打真实 API）。
- `createAgent()` 三行代码示例在 `examples/` 中可运行。
- 配置分层的局部覆盖有测试；校验错误信息指明层与键路径。
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm examples` 全绿，CI 不含真实网络调用。

## 工作方式

新分支 `feat/m1-1-first-real-provider`，小步 commit，PR 描述含 Decisions / Open Questions / 验收逐条勾选，并附 `git log --oneline` 与 head SHA。
