# first-real-provider

`index.ts` 是不访问网络的三行 `createAgent()` Facade 示例，由 `pnpm examples` 执行。

`live.ts` 是显式实机入口：运行一个包含 `EchoTool` 的多步 turn，录制规范化 ModelPort 交互，随后用新的 EventLog 与 Tool 回放，并比较除 `ts` 外的完整事件流。命令只将录制写到标准输出，可按需重定向到本地文件。

原生工具端点示例：

```bash
OAC_RUN_LIVE=1 \
OAC_MODEL_BASE_URL=http://127.0.0.1:11434/v1 \
OAC_MODEL_NAME=qwen3:8b \
OAC_MODEL_MAX_CONTEXT=32768 \
OAC_MODEL_TOOL_USE=native \
pnpm --filter @openagentcore/first-real-provider live > /tmp/oac-native-recording.json
```

Prompted 降级端点把 `OAC_MODEL_TOOL_USE` 改为 `prompted`。脚本不会探测或猜测端点能力，也不会因环境变量存在而被常规测试自动执行。
