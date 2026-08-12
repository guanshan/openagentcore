# @openagentcore/kernel（L1）

`@openagentcore/kernel` 是运行时依赖为零的事件溯源内核。当前提供 AgentEvent、EventLog、SnapshotStore、消息与 Session 投影、可恢复的 `AgentLoop`、Model/Tool/Sandbox/Store/Trace/Vault Port、Strategy 注册表及五条 Middleware 管道。

`ScriptedModelPort` 与测试工具用于确定性测试和示例，不包含真实 Model Provider；Runtime、UI 与 CLI 位于上层包。

`StorePort` 只定义 byte-native KV 与按身份打开 EventLog 的 provider-neutral 边界；数据库驱动和持久化能力声明在 L2 Provider。`TracePort` 使用显式 parent 的 portable span/metric 数据，内置 `NoopTracer` Null Object；AgentLoop 在未注入 exporter 时不会产生 IO，也不依赖 OpenTelemetry SDK。`VaultPort` 只向工具签发带过期/刷新语义的不透明 scoped 请求代理；`withCredential(scope)` 在执行期注入，并以 `credential.used` 记录 audit-safe scope，不把认证 material 放进工具、事件或 trace。

## Permission policy 规则

Tool 可通过 `describeAction(args, signal)` 在授权前补充解析后的资源信息。Kernel 将工具名、原始参数、permission、规范绝对路径以及命令/可执行名合并成 `ActionDescriptor`，先写入 `permission.requested`，再把同一份描述交给 Permission Strategy。授权恢复优先使用事件中已经持久化的描述，避免文件系统变化造成判定漂移。

内置 `policy-file` 使用常见的 shell-style glob（`*`、`**`、`?`），不读取文件也不定义新的配置 DSL：

- `tool`、`group`、`permissionKind` 是精确匹配；`path`、`command`、`executable` 是 glob 匹配；同一规则内的选择器全部满足才算匹配。
- 规则严格按声明顺序求值，**首个匹配生效**；没有规则匹配时使用 `defaultDecision`，不存在隐式 deny 优先级。
- 相对 `path` 针对 `ActionDescriptor.paths.root` 的相对路径匹配，绝对 `path` 针对规范绝对路径匹配。`pathAccess` 可选 `read`、`write`、`any`（默认 `any`）；一次 action 有多个所选路径时必须全部匹配，避免用一个允许路径夹带其他路径。
- `command` 匹配调用方提交的完整命令文本；`executable` 匹配 Tool 解析出的首个可执行文件名。路径穿越、软链逃逸和无法解析的命令在进入策略前由 Tool 的执行前置条件拒绝。
