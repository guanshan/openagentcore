# 可组合 Agent 基建平台 · 总体设计文档

> 正式名称 **OpenAgentCore**（下文简称 OAC）。npm 作用域 `@openagentcore/*`，Python 发行名 `openagentcore`，CLI 命令 `oac`。
> 版本：v0.1 草案 · 2026-08-11 · 许可证：Apache-2.0

---

## 1. 定位与愿景

**一句话定位**：一个开源的、分层的 Agent 基建组合层（Infra Composition Layer）——让开发者自由组合各家 LLM / Sandbox / 网关 / 可观测 / 中间件产品（腾讯云、阿里云、火山引擎、知名开源组件），并在其上快速做出生产级 Coding Agent 产品，形态可以是嵌入式 App、客户端产品或后台 Server。

三个核心判断：

1. **组合优于绑定**。各家基建能力参差不齐、各有精华，平台的价值在于用统一抽象把它们变成可插拔的零件，"取其精华、去其糟粕"。
2. **一切策略皆可换、一切 Prompt 皆可见**。压缩策略、记忆策略、路由策略是可选模式；内核没有拿不到、改不了的隐藏 Prompt。这是 SDK 对上游的根本承诺。
3. **SDK-first，分层向上生长**。最底层是无 IO 依赖、可嵌入任何进程的 Kernel；Server、UI、CLI 都是上层独立包（对标 pi-sdk 的分层哲学）。零依赖能跑通 demo，配置齐了能上生产。

### 1.1 非目标（Non-Goals）

- 不做又一个大而全的编排框架（不与 LangGraph 在"图编排 DSL"上竞争；图编排可作为上层扩展）。
- 不重造模型网关（LiteLLM/OneAPI/各云网关是被适配对象，不是竞品）。
- 不做托管 SaaS（开源自部署优先；商业托管是后话）。
- V1 不追求全模态（文本 + 代码优先，多模态留接口）。

### 1.2 差异化主张

| 主张 | 说明 |
| --- | --- |
| 国内云一等公民 | 腾讯云 / 阿里云 / 火山引擎的 Sandbox、网关、可观测、Vault 开箱即用，并有 conformance 认证 |
| 事件溯源内核 | 崩溃恢复、时间回溯、确定性回放、审计，是同一个存储模型的四个免费副产品 |
| 生产级 Coding Agent 内核 | 代码索引、Git 工作流、验证闭环、权限审批，不是 demo 玩具 |
| 全量可调 | Strategy 注册表 + Middleware 链 + Prompt 注册表，三个机制覆盖所有定制点 |

---

## 2. 总体架构

### 2.1 四层架构（依赖只向下）

```text
┌─────────────────────────────────────────────────────────┐
│  L4  Apps          CLI · Web 控制台 · IDE 插件 · UI Kit  │
├─────────────────────────────────────────────────────────┤
│  L3  Runtime       HTTP/WS Server · A2A Server · MCP    │
│                    Server · 任务队列 · 触发器 · 多租户    │
├─────────────────────────────────────────────────────────┤
│  L2  Providers     LLM · Sandbox · Store · Vault ·      │
│                    Tracing 的各家 Adapter（独立可选包）   │
├─────────────────────────────────────────────────────────┤
│  L1  Kernel        Agent Loop · 事件模型 · 工具抽象 ·    │
│      (无 IO 依赖)   Prompt 系统 · 权限 · Context 管理    │
├─────────────────────────────────────────────────────────┤
│  L0  Spec          语言无关协议：事件流 / 工具 Schema /   │
│                    Trajectory 格式 / UI 线协议 (JSON)    │
└─────────────────────────────────────────────────────────┘
```

- **L0 Spec（协议先行）**：TS 与 Python 双 SDK 各自实现同一份 JSON Schema 定义的 spec，防止双语言漂移。Spec 随 TS 仓维护、独立发版，带跨语言一致性测试（仓库组织见 §16.1）。
- **L1 Kernel**：纯逻辑，不直接触碰网络/磁盘，一切 IO 通过 Port 接口注入。可嵌入浏览器（TS）、Electron、任意后端进程。
- **L2 Providers**：每家云 / 每个开源组件一个独立包（`@openagentcore/tencent`、`openagentcore-aliyun`……粒度见 §16.3），核心包零云依赖。
- **L3 Runtime**：需要"起 server"的能力全部在这层，Kernel 用户可以完全不引入。
- **L4 Apps**：官方 CLI、调试控制台、React UI Kit，也是吃自己狗粮的参考实现。

### 2.2 架构风格：六边形架构（Ports & Adapters）

Kernel 定义 **Port**（出站接口），Providers 提供 **Adapter**（实现）。这是全项目的第一设计模式，其余模式都挂在这个骨架上：

```ts
// L1 Kernel 定义的 Port（节选）
interface ModelPort {
  readonly capabilities: ModelCapabilities;      // 能力协商，见 §7.1
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
  countTokens(req: ModelRequest): Promise<number>;
}

interface SandboxPort {
  readonly capabilities: SandboxCapabilities;
  exec(cmd: ExecRequest): Promise<ExecHandle>;
  fs: SandboxFsPort;                             // 读写文件的子 Port
  snapshot?(): Promise<SnapshotRef>;             // 可选能力
  restore?(ref: SnapshotRef): Promise<void>;
}

interface StorePort {        // MySQL/Redis/SQLite/内存 统一收敛为 KV + 流两种原语
  kv: KvPort;
  eventLog: EventLogPort;    // 事件溯源的持久化底座
}

interface VaultPort {
  issue(scope: CredentialScope): Promise<ShortLivedCredential>;  // 只发短期凭证
}

interface TracePort { /* OpenTelemetry GenAI 语义，见 §12 */ }
```

**反腐层（Anti-Corruption Layer）**：每个云厂商 Adapter 内部消化该厂商 SDK 的概念与怪癖，不允许厂商类型泄漏进 Kernel API。厂商 SDK 升级只影响单个 provider 包。

---

## 3. 领域模型

```text
Agent ──定义──> AgentDefinition (prompt slots + tools + strategies + policies)
Session ──1:N──> Turn ──1:N──> Step ──产生──> AgentEvent (不可变、追加写)
Session ──物化──> Trajectory (事件流的只读投影，spec 定义格式)
Tool / Skill / Connector / SubAgent ──注册于──> Registry
```

关键约定：

- **AgentEvent 是唯一事实来源**（Single Source of Truth）。Session 的任何状态（消息历史、待审批项、成本累计）都是事件流的投影，可随时重建。
- **Turn** 是一次用户输入到 agent 停止的完整过程；**Step** 是一次模型调用 + 其工具执行。
- **Trajectory** 是面向调试/回放/eval 的标准导出格式，spec 定版本号，向后兼容。

---

## 4. Kernel：事件溯源的 Agent Loop

### 4.1 事件溯源（Event Sourcing）+ 快照（Memento）

```ts
type AgentEvent =
  | { type: 'turn.started';        turnId: string; input: UserInput }
  | { type: 'model.request';       stepId: string; assembled: ContextAssembly }
  | { type: 'model.delta';         stepId: string; delta: TextOrToolDelta }
  | { type: 'tool.call';           callId: string; tool: string; args: unknown }
  | { type: 'tool.result';         callId: string; result: ToolResult }
  | { type: 'permission.requested';reqId: string; action: ActionDescriptor }
  | { type: 'permission.resolved'; reqId: string; decision: 'allow'|'deny' }
  | { type: 'compaction.applied';  summary: string; dropped: EventRange }
  | { type: 'checkpoint.created';  snapshotRef: string }
  | { type: 'turn.finished';       turnId: string; stopReason: StopReason }
  // ... 全集在 L0 spec 中定义
```

由此免费获得四种能力：

| 能力 | 实现方式 |
| --- | --- |
| 崩溃恢复 | 重启后从 EventLog 重放（或从最近 Memento 快照 + 增量事件）恢复到崩溃前一刻 |
| 时间回溯 | 截断到第 N 个事件、修改参数、从该点重新执行（分叉出新 Session） |
| 确定性回放 | 录制模式下把 provider 响应也记为事件，回放时不打真实 API（见 §13.2） |
| 审计 | 事件流本身就是完整审计日志，含每次权限决策与凭证使用 |

快照策略（Memento）：每 K 个事件或每次 compaction 后落一个状态快照，恢复 = 最近快照 + 尾部事件重放，避免长会话重放过慢。

### 4.2 Agent Loop：模板方法（Template Method）

主循环骨架固定，各步骤是可覆盖的策略挂点：

```ts
abstract class AgentLoop {
  async runTurn(input: UserInput): Promise<TurnResult> {
    this.emit({ type: 'turn.started', ... });
    while (!this.shouldStop()) {                 // ← StopStrategy
      const ctx  = await this.assembleContext(); // ← ContextPipeline（§8）
      const resp = await this.callModel(ctx);    // ← Middleware 链包裹（§5.2）
      const calls = this.parseToolCalls(resp);
      await this.executeTools(calls);            // ← 并行策略 / 权限门 / Decorator
      await this.maybeCompact();                 // ← CompactionStrategy
      await this.maybeCheckpoint();              // ← CheckpointPolicy
    }
    this.emit({ type: 'turn.finished', ... });
  }
  // 每个 protected 方法都可被子类覆盖，但 99% 的定制应走 Strategy/Middleware
}
```

**可打断性（Steering）是循环的内建属性**：事件循环每步检查注入队列，用户消息可在 Turn 中途插入，`AbortSignal` 贯穿所有 Port 调用。这一点无法后补，必须在骨架里。

### 4.3 Session 状态机（State 模式）

`idle → running → waiting_approval → running → compacting → ... → done | failed | aborted`。状态转移由事件驱动，非法转移在类型层面被拒绝。恢复时状态从事件流推导，不单独持久化（避免双写不一致）。

---

## 5. 两大通用扩展机制

> 设计纪律：**任何新的"可定制需求"，先问能否用 Strategy 或 Middleware 表达；两者都不行才允许加新机制。** 这是防止 SDK 配置项爆炸的宪法条款。

### 5.1 Strategy + Registry（策略 + 注册表）

所有"可选模式"共享同一生命周期接口，按 kind + name 注册：

```ts
interface Strategy<TInput, TOutput, TConfig = unknown> {
  readonly kind: StrategyKind;   // 'compaction' | 'memory' | 'routing' | 'retry'
                                 // | 'tool-selection' | 'planning' | 'permission' ...
  readonly name: string;         // 'sliding-window' | 'llm-summary' | 'hierarchical'...
  init(config: TConfig, ports: KernelPorts): Promise<void>;
  apply(input: TInput, ctx: StrategyContext): Promise<TOutput>;
  metrics?(): StrategyMetrics;   // 供效果对比（压缩率、成本、eval 分）
}

// 使用：配置切换，无需改代码
registry.register(new SlidingWindowCompaction());
registry.register(new LlmSummaryCompaction());
// config: { compaction: { use: 'llm-summary', config: { targetRatio: 0.3 } } }
```

内置策略清单（V1）：

| kind | 内置实现 |
| --- | --- |
| compaction | `none` / `sliding-window` / `llm-summary` / `hierarchical`（分层摘要） |
| memory | `none` / `session-local` / `file-based`（Claude Code 式）/ `vector-rag` |
| routing | `static` / `fallback-chain` / `task-tiered`（按难度分层用模型） |
| retry | `exponential-backoff` / `circuit-breaker` |
| tool-selection | `all` / `deferred-search`（工具多时按需加载 schema） |
| planning | `direct` / `plan-then-execute`（Plan 模式，出计划待批准） |
| permission | `allow-all` / `policy-file` / `interactive-ask` |

社区贡献一种新压缩算法 = 发一个 npm/pypi 包，在入口 `register()`，内核零改动（**开闭原则**的直接体现）。

### 5.2 Middleware 链（责任链模式）

所有关键路径都是可插拦截器的管道，同一签名（洋葱模型，同 Koa/tower）：

```ts
type Middleware<Ctx> = (ctx: Ctx, next: () => Promise<void>) => Promise<void>;

// 五条内置管道
agent.use('model',      m);  // 模型调用前后：改 prompt、记账、缓存、注入
agent.use('tool',       m);  // 工具调用前后：审计、改写参数、拦截、脱敏
agent.use('context',    m);  // context 组装的最后一站：全量检查/改写 messages
agent.use('memory',     m);  // 记忆读写前后
agent.use('event',      m);  // 事件落盘前：过滤、富化、外发
```

"上游修改调试各种 Prompt"的底层机制就是 `model` 管道的一个 middleware；"PII 脱敏"是 `tool` 管道的一个 middleware。**Hooks 机制是 Middleware 的配置化形态**（用户在配置文件里声明命令/脚本，Runtime 把它包装成 middleware 注入），二者不是两套系统。

### 5.3 工具包装：装饰器（Decorator）

横切能力以 Decorator 叠加在任意 Tool 上，与 Middleware 的区别是它按"单个工具"粒度组合：

```ts
const tool = withAudit(withRateLimit(withCache(withRetry(rawTool), cachePolicy)));
```

内置 Decorator：`withRetry` / `withCache` / `withRateLimit` / `withAudit` / `withTimeout` / `withCredential(scope)`（执行期才向 Vault 换短期凭证，用完即弃——**Proxy 模式**：工具拿到的是凭证代理，永远接触不到长期密钥）。

---

## 6. 工具与能力生态

### 6.1 统一工具模型（Command 模式）

ToolCall 是可序列化的命令对象：有 ID、参数、来源，可入事件流、可重放、可在审批门前挂起。所有来源的工具收敛为同一运行时形态：

```text
本地函数工具 ─┐
MCP Server ──┤
Connector ───┼──> Tool (统一接口: name/schema/permission/execute)
OpenAPI 导入 ─┤
SubAgent ────┘   （子 agent 也是一种工具——Composite 视角）
```

- **ToolGroup（Composite）**：工具可分组挂载/卸载，组可以嵌套（如 `git/*`、`fs/readonly/*`），权限策略按组配置。
- **动态发现**：工具多时用 `deferred-search` 策略——只暴露工具名录，模型按需拉取 schema（参考 ToolSearch 的做法），省 context。
- **MCP**：Kernel 内建 MCP client（stdio/HTTP/SSE 三传输）；L3 Runtime 提供 MCP server（把 OAC agent 反向暴露为别人的 MCP 工具）。
- **Connector 规范**：connector = 带 manifest（名称/版本/权限声明/凭证 scope）的工具包，统一打包格式，为社区 registry 铺路。

### 6.2 Skill 注入

Skill = 指令 + 资源 + 可选工具的可安装包（对齐 Claude Skills / agentskills 的思路）：

- 按需加载：默认只有名称与一行描述进 system prompt，触发时才注入全文（渐进披露，省 context）。
- Skill 的注入点是 Prompt 系统的一个 slot（§8），可被上游覆盖或禁用。
- 支持文件目录、git 仓库、registry 三种安装来源；带版本与 lockfile。

### 6.3 SubAgent 与 A2A

- **进程内 SubAgent**：fork 出隔离 context 的子循环，父子通过事件桥接；预算控制（token/步数/时间）在 spawn 参数里强制声明。
- **A2A 协议**：L3 Runtime 实现 A2A server/client——AgentCard 发布、任务委托、长任务异步回调。**远程 agent 在 Kernel 视角也只是一个 Tool（Adapter + Proxy）**，编排逻辑不感知本地/远程差异。

### 6.4 Coding Agent 能力包（`@openagentcore/coding`）

作为 Kernel 之上的官方能力包（不进 Kernel，保持内核领域无关）：

| 能力 | 内容 |
| --- | --- |
| 代码理解 | tree-sitter 解析、repo map、LSP 客户端（定义/引用/诊断）、可选 embedding 索引 |
| Git 工作流 | worktree 隔离（多 agent 并行不打架）、自动分支、commit/PR 生成、diff 审查 |
| 验证闭环 | 测试/lint/构建的标准化 Verifier 接口，"改完自己验证"进入循环的 shouldStop 判据 |
| 编辑原语 | 精确字符串替换、patch 应用、冲突检测（对齐 Claude Code / opencode 的编辑工具语义） |
| 安全默认 | 危险命令识别、默认沙箱执行、路径白名单 |

---

## 7. Provider 体系

### 7.1 能力协商（Capability Negotiation）

每个 Adapter 声明能力位图；Kernel 对缺失能力**自动降级并显式记录**（dry-run 与事件流中可见降了什么）：

```ts
interface ModelCapabilities {
  streaming: boolean; toolUse: 'native' | 'prompted' | 'none';
  promptCaching: boolean; structuredOutput: boolean;
  maxContext: number; vision: boolean;
}
// 例：toolUse === 'prompted' 时，Kernel 自动切换到文本协议模拟工具调用
```

### 7.2 创建与装配：抽象工厂 + Builder + 组合根

- **抽象工厂（Abstract Factory）**：`preset` 即一族 Provider 的工厂——`preset: 'tencent-full'` 产出腾讯云的 Model/Sandbox/Store/Vault/Trace 全套；`preset: 'oss-local'` 产出 Ollama + Docker + SQLite + 文件 Vault + 控制台 Trace。用户在 preset 之上局部覆盖。
- **Builder**：`AgentBuilder` 收敛所有装配入口，流式 API，`build()` 时做配置校验与能力协商：

```ts
const agent = AgentBuilder.fromPreset('tencent-full')
  .model('volc-ark/deepseek-v3', { fallback: 'tencent/hunyuan' })  // 跨家混搭
  .strategy('compaction', 'llm-summary', { targetRatio: 0.3 })
  .use('tool', auditMiddleware)
  .promptOverride('system.identity', myIdentityPrompt)
  .build();
```

- **依赖注入（构造注入，无容器魔法）**：Kernel 一切依赖显式传入，组合根在 Builder；不引入 DI 框架，保证可调试性与树摇。
- **Null Object**：每个 Port 都有 Noop/InMemory 默认实现（`NoopTracer`、`InMemoryStore`、`LocalProcessSandbox`），**零配置零依赖可跑通完整 demo**——这是开源采用率的生命线。

### 7.3 稳定性模式（非 GoF，同等重要）

- **Circuit Breaker**：Provider 连续失败后熔断，走 fallback 链。
- **Bulkhead**：per-provider 并发池隔离，一家网关抖动不拖垮全局。
- **超时与重试预算**：所有 Port 调用强制显式 timeout；重试策略是 Strategy（可换）。

### 7.4 V1 Adapter 矩阵（规划）

| Port | 国内云 | 开源/通用 |
| --- | --- | --- |
| Model | 腾讯混元 / 阿里百炼 / 火山方舟 | OpenAI-compatible（一个 adapter 通吃 LiteLLM/OneAPI/Ollama/vLLM）、Anthropic |
| Sandbox | 腾讯云 CodeBuddy Sandbox / 阿里云 / 火山 | 本地进程、Docker、E2B |
| Store | TDSQL/云 Redis 等（走标准协议） | MySQL、Redis、PostgreSQL、SQLite、内存 |
| Vault | 各云 KMS/凭据管理 | HashiCorp Vault、加密文件、环境变量 |
| Trace | 腾讯云 APM / 阿里云 SLS / 火山 APMPlus | OTLP（Langfuse/Jaeger/任意 OTel 后端） |

---

## 8. Prompt 系统（一等公民）

### 8.1 全量注册表 + Composite 组装

**纪律：Kernel 代码中不允许出现写死的 prompt 字符串**，一切经由 PromptRegistry：

```ts
prompts.get('system.identity')       // 身份段
prompts.get('system.tool-protocol')  // 工具使用规约
prompts.get('compaction.summarize')  // 压缩摘要用的隐藏 prompt
prompts.get('subagent.default')      // 子 agent 默认 prompt
prompts.get('error.retry-hint')      // 出错重试提示语
// prompts.list() 可枚举全集——没有黑盒
```

System prompt 是 **slot 树（Composite 模式）**：`identity / capabilities / tool-protocol / project-context / skills / user-custom` 逐段拼装。上游只覆盖某个 slot，SDK 升级不冲掉用户定制（对整体替换方案的决定性优势）。

### 8.2 版本、热更新与实验

- Prompt 可来自内置默认 / 文件目录 / 远端配置中心，带版本号；文件变更热加载，不重启不发版。
- 与 eval 框架（§13）打通：同一录制 trajectory 上 A/B 两个 prompt 版本，diff 行为与指标。

### 8.3 Context 组装管道（Pipeline，调 prompt 的显微镜）

Context 组装是显式的多阶段管道，每阶段产物可检查：

```text
history → [memory 注入] → [skill 注入] → [compaction] → [slot 拼装] → [middleware 终审] → messages
```

**Dry-run 模式**输出 `ContextAssembly` 报告：最终 messages 全文、每段来源（哪个 slot/策略产生）、逐段 token 数、发生过的降级。没有这个，上游调 prompt 等于闭眼开车。

---

## 9. 记忆与压缩

二者都是 Strategy（§5.1 已列内置实现），补充设计要点：

- **压缩是事件，不是覆盖**：`compaction.applied` 事件记录摘要与被折叠区间，原始事件仍在 EventLog——回放与审计不受损，"解压回看"成为可能。
- **记忆分层**：turn 内工作记忆（免费，就是 context）→ session 记忆 → 跨 session 长期记忆（文件式或向量式）。写入时机（显式工具 / 自动抽取）与召回方式（索引加载 / 检索）都是策略参数。
- **策略效果可比**：每个策略实现 `metrics()`，Trace 中带 `strategy.name` 维度——压缩率、信息保留 eval 分、成本，选型看数据不看玄学。

---

## 10. 权限、审批与安全

- **权限即策略**：`PermissionStrategy` 输入 ActionDescriptor（工具名、参数、路径、命令模式），输出 `allow | deny | ask`。规则文件语法对齐主流 coding agent 习惯（tool + 参数 glob）。
- **审批门**：`ask` 产生 `permission.requested` 事件 → Session 进入 `waiting_approval` → UI/API 回填决策。**审批是事件流的一部分**，崩溃后恢复到待审批状态，不丢。
- **Plan 模式**：planning 策略 = `plan-then-execute` 时，先以只读工具集探索并产出结构化计划，批准后才解锁写操作。
- **凭证**：Vault 只发短期 scoped 凭证（§5.3 的 `withCredential` Proxy）；事件流记录"谁在哪步用了什么 scope"，但永不落密钥明文。
- **注入防线**：工具返回内容标记为不可信来源，`context` 管道内置防线 middleware（不可信内容中的指令模式识别与围栏），可关可换。
- **多租户预留**：所有持久化 schema 从第一天带 `tenant_id`；RBAC/配额在 L3 实现，L1 只透传身份。

---

## 11. Runtime 与 UI 线协议

### 11.1 UI 线协议（L0 Spec 的一部分）

Agent 运行时与 UI 之间的流式事件协议（对齐 AG-UI 思路）：文本增量、工具卡片、diff、审批请求、进度、成本。**同一协议服务三种形态**：

| 形态 | 拓扑 |
| --- | --- |
| 后台 Server | agent 在 L3 Runtime，客户端经 WS/SSE 消费协议 |
| 客户端产品 | agent 嵌入 Electron/App 进程，进程内事件直喂本地 UI |
| 混合 | UI 在本地、agent 在云端，断线重连后凭事件序号续流 |

### 11.2 L3 Runtime 能力

- HTTP/WS API（Session CRUD、事件流订阅、审批回填、Steering 注入）
- **触发器**：cron、webhook、Git 事件（PR 打开自动 review）——从"聊天工具"到"自动化平台"的分水岭
- 任务队列 + durable execution：长任务可暂停/恢复/迁移节点（事件溯源使 worker 无状态化）
- A2A server、MCP server、OpenAI-compatible 出口（把 agent 伪装成一个 chat model 供旧系统接入）
- 多租户、RBAC、审计导出、配额与预算硬上限

### 11.3 L4 官方前端资产

- `@openagentcore/ui-react`：会话流、diff 审查、审批弹窗、Trajectory 查看器的组件与 hooks——"半天拼出产品界面"的最后一公里
- CLI：本地跑 agent、调试、录制回放、conformance 测试入口
- 调试控制台：Trajectory 可视化（每步 prompt / 工具 / 耗时 / 花费）、Context dry-run 查看器

---

## 12. 可观测

- 直接采用 **OpenTelemetry GenAI 语义约定**为唯一内部标准；腾讯云 APM、阿里云 SLS、火山 APMPlus、Langfuse 全部只是 exporter 配置，不为任何一家单独设计埋点。
- 三类信号：Trace（step 级 span 树）、Metrics（token/成本/延迟/策略效果）、事件流本身（可外发到消息队列）。
- 成本核算：per-session / per-tenant / per-strategy 的 token 记账，预算硬上限触发 `turn.finished(stopReason: budget)`。

---

## 13. 质量体系

### 13.1 Conformance Suite（生态治理的抓手）

官方标准测试套件，按 Port 分卷。任何第三方 Adapter 跑过即获认证徽章；**能力矩阵文档从测试结果自动生成**——"精华糟粕"有据可依，社区生态有质量底线。

### 13.2 Record & Replay

- 录制模式：所有 Port 交互（含模型响应）落入事件流。
- 回放模式：Port 全部换成回放 Adapter（又是 Null Object/Proxy 的用武之地），**离线、免费、确定性**地重跑——改 prompt/策略后与原始运行 diff 行为。
- Mock provider 内置：CI 不需要真实 key。

### 13.3 Eval 框架

- Trajectory 为标准输入格式；内置 LLM-judge 与规则断言两类 evaluator。
- SWE-bench 类基准的 runner 适配（吃自己狗粮：用 OAC 的 sandbox port 跑基准）。
- Prompt/策略改动的回归门禁：PR 上自动跑固定 trajectory 集。

---

## 14. 配置系统

分层合并，每层可局部覆盖（与 §8 的 prompt override 同构）：

```text
内置默认 < preset < 项目配置文件 < 环境变量 < 代码显式传参 < （客户端产品的）终端用户设置
```

- 配置 schema 由 L0 spec 定义，双语言共享校验规则；错误信息指出出错的层与键路径。
- 声明式（YAML/JSON，平台方友好）与代码式（Builder，开发者友好）双轨同构：YAML 就是 Builder 调用的序列化。

---

## 15. 设计模式总览（速查表）

| 模式 | 落点 | 解决什么 |
| --- | --- | --- |
| Ports & Adapters（六边形） | 全局骨架 | Kernel 与基建解耦，厂商可插拔 |
| Anti-Corruption Layer | 每个 Provider 包 | 厂商 SDK 概念不泄漏进内核 |
| Event Sourcing | Session 状态 | 崩溃恢复/回放/审计/回溯 四合一 |
| Memento | Checkpoint 快照 | 长会话恢复提速 |
| Template Method | AgentLoop | 循环骨架稳定，步骤可挂策略 |
| State | Session 状态机 | 非法状态转移在类型层面被拒绝 |
| Strategy + Registry | 压缩/记忆/路由/权限/… | 一切模式可换，配置切换，社区可贡献 |
| Chain of Responsibility | 五条 Middleware 管道 | 拦截/改写/审计的统一机制，Hooks 的底座 |
| Decorator | 工具包装 | 缓存/限流/审计/凭证按工具粒度叠加 |
| Command | ToolCall | 可序列化、可挂起待批、可重放 |
| Composite | Prompt slot 树 / ToolGroup / SubAgent | 局部覆盖、分组权限、子 agent 即工具 |
| Adapter | 所有 Provider | 统一 Port 语义 |
| Abstract Factory | Preset | 一行切换整族基建 |
| Builder | AgentBuilder | 装配收敛、构建时校验 |
| Proxy | 远程 agent / 凭证代理 / 回放 Adapter | 位置透明、密钥隔离、离线回放 |
| Facade | `createAgent()` 顶层 API | 三行代码跑通，复杂度按需展开 |
| Null Object | Noop/InMemory 实现 | 零依赖跑通 demo |
| Observer / Pub-Sub | 事件总线 | UI/Trace/外发订阅同一事件流 |
| Pipeline | Context 组装 | 每阶段可检查，dry-run 显微镜 |
| Circuit Breaker / Bulkhead | Provider 稳定性 | 单点抖动不拖垮全局 |
| Saga / Durable Execution | L3 长任务 | 暂停/恢复/迁移 |

**反模式警戒线**：不引入 DI 容器魔法；不做深继承层次（组合优先）；不允许"第 3 种扩展机制"未经宪法条款（§5 开头）审议进入内核；Kernel 不出现任何厂商类型与写死 prompt。

---

## 16. 仓库与目录组织

### 16.1 仓库切分：两个仓，不是三个

TS 与 Python 各一仓。spec 不单独成仓：项目早期独立 spec 仓的同步成本大于收益（改一个事件字段要开三个 PR、对三次版本），先作为 TS 仓的顶层目录 `spec/` 维护、独立发版（npm 包 + 语言无关 tarball），Python 仓在 CI 里按锁定的版本号拉取 schema 与测试向量。等出现第三方语言实现时再拆仓——把一个目录拆出去很容易，把两个仓合回来很难。

TS 为 spec 参考实现（先行半个版本），Python 跟进；两侧必须同时通过 spec 的一致性测试向量才能发版。

### 16.2 TS 仓顶层：六个目录，一个生长轴

```text
openagentcore/
├── spec/          # L0：JSON Schema、协议文档、conformance 测试向量（独立发版）
├── packages/      # 固定成员：kernel / coding / runtime / ui / cli —— 不再增长
├── providers/     # 唯一的生长轴：一个厂商一个目录
├── examples/      # 可运行示例，只 import 公开 API
├── docs/          # 设计文档 + ADR（架构决策记录）
└── （根配置：pnpm-workspace / tsconfig.base / changesets ...）
```

设计意图：**整个仓库只有一个指定的生长方向**。`packages/` 的五个成员与 L1–L4 分层一一对应，长期固定；想新增顶层包，必须先写一篇 ADR 说明为什么现有五个都放不下。所有可预见的膨胀——对接更多厂商——都被引导进 `providers/`：每个厂商目录内部再怎么涨，都不会增加其他目录的认知负担，删掉一个厂商也只是删一个目录。

### 16.3 Provider 粒度：按厂商分包，按 Port 分子路径

不做"一 Port 一包"（`provider-tencent-sandbox`、`provider-tencent-model`……N 厂商 × 5 Port 的包数爆炸，每个包背一套 package.json、tsconfig、CI 与发版流程）。改为**一厂商一包，Port 用 subpath export 区分**：

```text
providers/tencent/      → @openagentcore/tencent
  src/model/              import { HunyuanModel }  from '@openagentcore/tencent/model'
  src/sandbox/            import { CloudSandbox }  from '@openagentcore/tencent/sandbox'
  src/trace/              ...
providers/aliyun/       → @openagentcore/aliyun
providers/volcengine/   → @openagentcore/volcengine
providers/standard/     → @openagentcore/standard   # 无厂商归属的通用件：/mysql /redis /docker /openai /otlp
```

理由：同一厂商的多个 Port 共享认证与账号配置，天然内聚；厂商 SDK 升级的影响半径被锁死在一个目录；subpath export 配合把重依赖（mysql2、dockerode、各云 SDK）声明为 peerDependencies，用户按需安装，不会因为只想用 Redis 被迫拖下 MySQL 驱动。

`@openagentcore/standard` 收容不属于任何厂商的开源通用适配器；而本地零依赖实现（内存 Store、本地进程 Sandbox、NoopTracer）按 Null Object 原则直接内置于 kernel，不占 provider 名额。

### 16.4 Python 仓：镜像目录结构，不镜像包数

```text
openagentcore-py/
├── spec-version.lock   # 锚定的 spec 版本，CI 据此拉取 schema 与测试向量
├── packages/
│   ├── openagentcore/       # kernel + coding 合并发布（见下）
│   └── openagentcore-runtime/
├── providers/          # openagentcore-tencent / -aliyun / -volcengine / ...
├── examples/
└── docs/
```

目录结构与 TS 仓对齐，降低双语言维护的心智切换成本；但**发布粒度尊重 Python 生态习惯**：能少一个 distribution 就少一个。教训取自 langchain——先用巨包加 extras，依赖冲突失控后被迫大拆分。我们直接按厂商切 distribution（依赖隔离的硬需求），但 kernel 与 coding 合并成一个 `openagentcore` 包：Python 用户几乎总是两者一起用，且二者没有重依赖差异，拆开只是徒增一次 pip install。

### 16.5 包内目录：按领域分，不按模式分

kernel 内部保持一层扁平的领域目录，禁止以设计模式或抽象层次命名目录（不出现 `factories/`、`base/`、`impl/`）：

```text
packages/kernel/src/
├── events/     # 事件定义、EventLog、快照
├── loop/       # AgentLoop、Turn/Step、状态机
├── tools/      # 工具模型、装饰器、MCP client
├── prompts/    # PromptRegistry、slot 组装
├── context/    # 组装管道、compaction 挂点
├── strategy/   # Strategy 接口与注册表（领域名，非模式名）
├── ports/      # 五个 Port 接口 + Null Object 默认实现
└── config/     # 分层配置解析
```

测试与源码同目录（`*.test.ts`），不设顶层 `tests/`。conformance 的测试向量属于 `spec/`，runner 做成 `oac conformance` CLI 子命令，不另立包。

### 16.6 防膨胀公约

写进 CONTRIBUTING，可机检的部分由 CI 强制：

1. **禁设垃圾抽屉**：不允许出现 `utils` / `common` / `shared` / `helpers` 包或目录。一段代码要么属于某个领域目录，要么想清楚它的真名。
2. **边界即代码**：分层依赖方向（§2.1）用 import-lint（dependency-cruiser / import-linter）在 CI 强制——kernel import runtime 直接红灯，不靠 review 自觉。
3. **新顶层包必附 ADR**；新 provider 必须通过 conformance 才能进主仓，过不了的先在自己仓库发布，由 README 的社区列表收录。
4. **examples 即 API 回归测试**：示例只许使用公开 API，CI 全量运行——公开 API 的破坏性变更会先在这里炸出来，而不是在用户升级之后。
5. **发版分轨**：`packages/` 五件套锁同一版本号整体发布（用户无需琢磨兼容矩阵）；`providers/` 各自独立发版（一家厂商 SDK 升级不牵动全局）。changesets 管理，CI 按路径过滤——改动某个 provider 只跑它自己的测试与 conformance。

---

## 17. Roadmap

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| **M0** 协议与内核 | L0 spec 定稿；TS Kernel：事件溯源循环、Strategy/Middleware/Prompt 三机制、Null Object 全套 | 零依赖跑通一个能崩溃恢复、可回放的最小 coding agent |
| **M1** Coding 能力包 + 本地 preset | `@openagentcore/coding` 全量；`oss-local` preset；CLI；Record&Replay | 在真实仓库完成一次"改代码→跑测试→提交"闭环，中断后恢复续跑 |
| **M2** 国内云 Providers | 腾讯/阿里/火山的 Model+Sandbox+Trace adapter；conformance suite v1 | `preset: 'tencent-full'` 一行切换，能力矩阵自动生成 |
| **M3** Runtime + UI Kit | L3 server、UI 线协议、`@openagentcore/ui-react`、审批流、触发器 | 用 UI Kit 半天拼出一个可用的 Web Coding Agent 产品 |
| **M4** Python SDK + 生态 | Python 镜像实现；Skill/Connector registry；eval 框架 | 双语言过 spec 一致性测试；首批社区 connector 认证 |

**打穿点（对外叙事）**：M1 完成即对外发布——"一个能崩溃恢复、可确定性回放、全量 Prompt 可调的开源 Coding Agent SDK"，M2 补上"国内云一等公民"的差异化，其余能力以插件形态生长。

---

## 附录 A：开放问题

1. 已定名 **OpenAgentCore**（2026-08-11 核查 npm / PyPI / GitHub 均无占用）。遗留：与 AWS Bedrock AgentCore 的商标摩擦风险需评估，正式发布前保留改名余地。
2. Sandbox 的文件系统语义统一（本地 FS vs 远程沙箱 FS 的路径映射与延迟差异）——需要单独设计文档。
3. UI 线协议是自定义还是直接采用/扩展 AG-UI 标准——倾向兼容 AG-UI，待评估其审批/diff 语义覆盖度。
4. A2A 与 MCP 的鉴权模型如何与 Vault 打通（远端凭证委托）。
5. 事件流的 schema 演进策略（事件版本化 vs upcaster 链）。
6. 双语言维护成本：Python 侧是否允许某些 L4 组件（UI Kit）只有 TS 实现。
