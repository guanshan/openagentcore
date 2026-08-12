# @openagentcore/standard

OpenAgentCore 的标准 Provider 与 TypeScript 组合根。当前公开 OpenAI-compatible Chat Completions 模型适配器、ModelPort 录制/回放，以及 `oss-local` preset。

## OpenAI-compatible ModelPort

```ts
import { OpenAICompatibleModel } from '@openagentcore/standard/model';

const model = new OpenAICompatibleModel({
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3:8b',
  capabilities: {
    maxContext: 32_768,
    toolUse: 'native',
  },
});
```

`baseUrl` 指向兼容 API 的版本根路径；适配器在其后追加 `chat/completions`。URL 不得包含 query、fragment 或 userinfo 凭据。认证信息通过 `apiKey` 或 `headers` 传入。

适配器不按厂商名称分支，也不猜测端点能力。除 `maxContext` 必填外，默认能力声明如下：

```json
{
  "streaming": true,
  "toolUse": "prompted",
  "promptCaching": false,
  "structuredOutput": false,
  "vision": false
}
```

只有经过确认的端点才应声明 `toolUse: 'native'`。声明为 `prompted` 时，Kernel 负责注入版本化工具协议与工具定义；适配器不会发送原生 `tools` 字段，也不会反解析 Prompt 文本以补造原生工具历史。

OpenAI-compatible Chat Completions 没有统一的 token 计数端点。默认 `estimateTokensByCharacters` 是确定性的字符估算，不代表模型 tokenizer 的精确结果。可通过 `tokenCounter` 注入与目标模型匹配的实现。

### 传输与错误

- 使用原生 `fetch` 和增量 SSE 解析；要求流以 `[DONE]` 结束并提供 finish reason。
- 按 `tool_calls[index]` 聚合交错的工具参数分片；缺少 ID、名称或完整 JSON 参数时报告协议错误，不补造数据。
- `AbortSignal` 直接传给 HTTP 请求；`timeoutMs` 控制整个流式请求的期限。
- HTTP 429、5xx、timeout、网络故障、内容过滤与无效请求映射为 Provider-neutral `ModelPortError`。
- 429 或 5xx 的 `Retry-After` 会映射为 `retryAfterMs`，由 Kernel Retry Strategy 作为最小等待时间。

兼容端点仍可能在 SSE 终止标记、错误 envelope、工具参数分片或 usage 字段上偏离这一公共子集。此类差异应通过 `requestBody`、headers 或明确能力声明表达；无法配置的差异需要独立 Adapter，不在本适配器中增加厂商特例。

## Record & Replay

```ts
import { RecordingModelPort, ReplayModelPort } from '@openagentcore/standard/model';

const recorder = new RecordingModelPort(model);
// 将 recorder 作为 AgentLoop 的 ModelPort，完成一次 turn。
const recording = recorder.snapshot();

const replay = new ReplayModelPort(recording);
// 将 replay 交给新的 AgentLoop；默认即时回放，不等待录制延迟。
replay.assertExhausted();
```

录制格式由 [`spec/schemas/model-recording.v0.json`](../../spec/schemas/model-recording.v0.json) 定义。它保存规范化后的请求、chunk、相对时序、错误和取消终态，不保存原始 HTTP、headers 或 SSE。

API key 与 Authorization header 属于 Adapter 构造配置，正常情况下不会进入录制。录制器还会递归遮蔽请求 metadata 与错误 details 中的常见敏感键，并支持 `additionalSensitiveKeys` 和 RFC 6901 `redactPointers`。Prompt、工具参数和模型输出属于程序语义，不做通用文本脱敏；凭据不得进入这些字段。

严格回放按调用顺序和结构化请求匹配，并可选择 `timing: 'recorded'`。整个 turn 的确定性还要求使用新的同身份 EventLog、相同 Prompt/Strategy 配置、确定性 Tool，并控制其他 Provider 与外部输入。

## AgentBuilder 与 oss-local

```ts
import { AgentBuilder } from '@openagentcore/standard';

const agent = AgentBuilder.fromPreset('oss-local')
  .configFile({ model: { name: 'qwen3:8b' } })
  .environment({ OAC_MODEL_MAX_CONTEXT: '32768' })
  .configure({ identity: { sessionId: 'demo' } })
  .build();
```

配置按以下优先级递归局部合并：

1. 内置默认值
2. preset
3. 已解析的配置文件对象
4. `OAC_*` 环境变量
5. 显式代码配置

`build()` 校验值、来源层与键路径。HTTP header 名按大小写不敏感规则覆盖；跨层的 `apiKey` 与 `headers.authorization` 由较高层生效，同层同时声明会报告冲突。

支持的环境变量：

| 变量                          | 配置路径                              |
| ----------------------------- | ------------------------------------- |
| `OAC_TENANT_ID`               | `identity.tenantId`                   |
| `OAC_SESSION_ID`              | `identity.sessionId`                  |
| `OAC_MODEL_BASE_URL`          | `model.baseUrl`                       |
| `OAC_MODEL_NAME`              | `model.name`                          |
| `OAC_MODEL_API_KEY`           | `model.apiKey`                        |
| `OAC_MODEL_TIMEOUT_MS`        | `model.timeoutMs`                     |
| `OAC_MODEL_STREAMING`         | `model.capabilities.streaming`        |
| `OAC_MODEL_TOOL_USE`          | `model.capabilities.toolUse`          |
| `OAC_MODEL_PROMPT_CACHING`    | `model.capabilities.promptCaching`    |
| `OAC_MODEL_STRUCTURED_OUTPUT` | `model.capabilities.structuredOutput` |
| `OAC_MODEL_MAX_CONTEXT`       | `model.capabilities.maxContext`       |
| `OAC_MODEL_VISION`            | `model.capabilities.vision`           |

当前 `oss-local` 诚实装配内存 EventLog、进程内 ToolRegistry、默认 Strategy/Prompt 与 OpenAI-compatible ModelPort。SandboxPort 已有独立的本地与 Docker 实现，但 preset 尚未注入 workspace root，因此不擅自构造；持久化 Store 与 OTLP Trace 需要显式注入，避免 preset 猜测文件路径、数据库或遥测端点。

## Docker SandboxPort

```ts
import { DockerSandbox } from '@openagentcore/standard/sandbox';

const sandbox = new DockerSandbox({
  root: '/path/to/repository',
  image: 'node:22-bookworm-slim',
});
```

Docker adapter 通过宿主 `docker` CLI 启动一次性、禁网容器，把仓库 bind mount 到 Port 统一的 `/workspace`。它不会自动拉镜像；Docker Engine 或指定本地镜像不可用时，`availability()` 返回明确原因，conformance 将该 adapter 报告为 `skipped`，常规 CI 不以 Docker 可用为前提。此实现不声明 snapshot 能力。

## Durable StorePort

```ts
import { AgentBuilder } from '@openagentcore/standard';
import { SqliteStore } from '@openagentcore/standard/store';

const store = new SqliteStore({ filename: './openagentcore.sqlite' });
const eventLog = store.eventLog.open({ tenantId: 'tenant-a', sessionId: 'session-a' });
const agent = AgentBuilder.fromPreset('oss-local').eventLog(eventLog).build();

// 进程关闭时：
await store.close();
```

SQLite 使用 Node 内置驱动，是零配置默认。MySQL 与 Redis 由 `MySqlStore.create({ uri })`、`RedisStore.create({ url })` 延迟加载；应用按需安装可选 peer `mysql2` 或 `redis`，驱动不进入 Kernel，也不是 standard 的 runtime dependency。

三个实现都以每流 head 做原子 CAS，标准持久化流只接受连续 `seq`，`read(fromSeq)` 返回调用时定界且可重复迭代的 primary 强一致有限快照。`subscribe` 仍只是打开该 EventLog 实例的进程内通知，不轮询数据库，也不伪装跨副本投递。

| Adapter | durability              | 可选前置条件    |
| ------- | ----------------------- | --------------- |
| SQLite  | `committed`             | 无              |
| MySQL   | `committed`             | `mysql2` + 主库 |
| Redis   | `deployment-configured` | `redis` + 主库  |

Redis 的 Lua 脚本保证 CAS、事件写入与 head 推进原子可见，但掉电或 failover 后是否保留已确认写取决于 AOF、复制和等待策略，因此不会声明与 SQLite/MySQL 相同的持久性。

## OTLP TracePort

```ts
import { AgentBuilder, OtlpTracePort } from '@openagentcore/standard';

const trace = new OtlpTracePort({
  endpoint: 'http://127.0.0.1:4318',
  resourceAttributes: { 'service.name': 'my-agent' },
});
const agent = AgentBuilder.fromPreset('oss-local').trace(trace).build();

// flush spans and metrics before process exit
await trace.shutdown();
```

Exporter 使用 OTLP/HTTP JSON 的 `/v1/traces` 与 `/v1/metrics`。AgentLoop 产生 `invoke_agent`、step、`chat` 与 `execute_tool` span 树；token 使用 `gen_ai.client.token.usage`，成本、step/turn/tool 延迟和 Strategy 效果使用 `openagentcore.*` 扩展指标。

`captureContent` 默认 `false`，因此 prompt、模型内容和工具参数/结果不进入 trace。显式开启后，内容先经过 Record & Replay 共用的敏感 key、Bearer/API key/access token 文本规则及 `additionalSensitiveKeys`，再序列化为 attribute。OTLP headers 只用于传输，不写入 payload。

## 离线与实机验证

常规测试只使用注入 transport、录制 fixture 与 `127.0.0.1` 随机端口 mock server，不访问真实端点。三行 Facade 示例及显式实机入口位于 [`examples/first-real-provider`](../../examples/first-real-provider)。实机入口只按该示例 README 的两步命令手动执行，并要求显式设置 `OAC_RUN_LIVE=1`。

真实模型与 Kernel 之间尚未解决的边界见 [ADR 0007](../../docs/adr/0007-first-real-model-boundary.md)。
