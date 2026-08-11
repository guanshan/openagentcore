# ADR 0007：首个真实模型边界与诚实降级

- 状态：已采纳（2026-08-11）
- 目标里程碑：M1-1（首个真实 Provider、Record & Replay、组合根）

## 背景

M0 只使用 `ScriptedModelPort`，因此若干内核假设尚未经过真实模型协议检验。OpenAI-compatible Chat Completions 接入暴露了以下差距：原生工具历史需要结构化 assistant tool calls；不支持原生工具的端点需要在 Prompt 中看到工具定义和文本结果；HTTP 错误需要携带可重试性与 `Retry-After`；兼容协议没有统一的能力发现或精确 token 计数接口。

这些差异不能由 Adapter 反解析内核文本、补造调用 ID、缓存随机输出或静默猜测能力来掩盖。

## 决策

1. Kernel 的 `ModelMessage` 保留结构化 `toolCalls`。同一步的多个原生工具调用组装为一条 assistant 消息，后续工具结果使用 `toolCallId` 关联。只有 `toolUse: 'prompted'` 或 `'none'` 时才使用 `OAC_TOOL_CALL` / `OAC_TOOL_RESULT` 文本历史。
2. Prompted 降级由 Kernel 完成。Context 的 `tool-protocol` slot 同时包含版本化协议指令与当前工具定义；Adapter 不把原生 `tools` 字段发送给声明为 prompted 的端点，也不从文本历史推断原生结构。
3. Kernel 定义 Provider-neutral 的 `ModelPortError`，记录 `kind`、`retryable`、HTTP 状态和可选 `retryAfterMs`。内置 Retry Strategy 对不可重试错误立即失败，并把服务端 `Retry-After` 作为最小等待时间。
4. `finish.reason: 'content-filter'` 由 Kernel 解释为不可重试模型错误；`finish.reason: 'error'` 解释为可重试服务错误。Provider 只归一化 wire 协议，不决定 turn 语义。
5. OpenAI-compatible 能力采用显式配置声明，不实现厂商特例探测。默认声明保持保守：支持 streaming，工具调用为 prompted，其余可选能力关闭；`maxContext` 必须显式提供。
6. `ModelPort.countTokens()` 继续满足现有必选契约。Adapter 支持注入模型对应的 token counter；`oss-local` 只能显式选择零依赖字符估算器，API 与文档均标记为 estimated，不把估算值描述为精确计数。
7. Record & Replay 录制规范化后的 ModelPort 交互，而不是原始 HTTP/SSE。API key 与 Authorization header 属于 Adapter 构造配置，不进入 `ModelRequest` 或录制文件；请求 metadata 与错误 details 仍执行可配置脱敏。
8. CI 只运行回放、注入 transport 和 loopback mock server。真实 Ollama、vLLM 或其他兼容端点测试必须通过独立手动命令显式启动，不能因环境变量存在而自动执行。

## 后果

- 原生与 prompted 工具历史都由 Kernel 生成可检查的规范表示，Provider 不需要针对内核缺口增加隐式修补。
- 429、5xx、timeout、内容过滤与请求错误可以进入同一套重试决策；录制回放也能保留该分类。
- `oss-local` 不增加 OpenAI SDK 或 tokenizer runtime dependency，但默认 token 数仅为估算。
- 录制文件可以确定性重放 ModelPort；整个 turn 逐字段一致仍要求相同配置、固定时钟和确定性的工具、权限、memory 与 steering 输入。

## 开放问题

1. [ADR 0006](0006-model-stream-retry-prefix.md) 要求重试输出逐 Unicode code point 复现已持久化前缀。真实随机模型不保证复现文本或工具调用 ID；后续需决定采用 Provider continuation、关闭部分重试，还是把分叉建模为新事件。Adapter 不缓存或改写输出来隐藏分叉。
2. OpenAI-compatible 没有统一的精确 token-count 或 capability-discovery API。`ModelCapabilities` 后续是否需要声明 token 计数精度、能力来源和探测时间，尚未决定。
3. `length`、缺少 finish、refusal 与 usage 缺失尚未完整进入 AgentEvent；当前事件流不能解释所有模型终止原因。
4. Prompted 文本协议当前每次响应只接受一个完整工具调用。是否扩展为多调用批次，以及如何兼容小模型的非严格 JSON，尚未决定。
5. 当前 Kernel 没有通用 `StorePort`、`SandboxPort` 或 `TracePort`，`AgentLoop` 也没有这些构造参数。M1-1 的 `oss-local` 只能装配内存 EventLog、进程内 Tool 和 ModelPort；不得用空壳类声称已实现尚未设计的 Port。
6. 同步 `AgentBuilder.build()` 可以校验分层配置与 Provider 能力声明，但 Strategy 的异步 `init()` 仍在首次运行时发生。是否增加显式异步初始化阶段，留待组合根生命周期设计。
7. 调用方取消只有在 Replay 收到对应 AbortSignal 时才能等价重现；离线回放不能自行伪造 caller cancellation，否则 Kernel 会错误进入 retry。
8. `streaming`、`maxContext`、`vision` 等能力目前除 `toolUse` 外尚未全部参与 Kernel 的自动降级与事件记录。
9. §14 设想由 L0 Schema 定义跨语言共享配置；本次只实现了 TypeScript 组合根的运行时校验，尚未形成 `agent-config` Schema 与一致性向量。后续需先统一配置契约，再扩展 Python 组合根，避免各语言重复校验并发生规则漂移。
10. SSE 内联错误缺少 HTTP 状态时，只能按稳定 `type` / `code` 识别已知分类；无法分类的错误当前按可重试 service failure 处理。后续协议是否需要显式携带端点原始分类与置信度，尚未决定。
