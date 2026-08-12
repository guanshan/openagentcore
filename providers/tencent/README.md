# `@openagentcore/tencent`

Tencent Cloud adapters for OpenAgentCore:

- `TencentHunyuanModel`: current TokenHub `hy3` model through the standard
  OpenAI-compatible adapter.
- `TencentAgentRuntimeSandbox`: Tencent Agent Runtime through its optional
  E2B-compatible SDK. Snapshot is honestly declared unavailable.
- `createTencentApmTrace`: standard OTLP/HTTP with Tencent Cloud resource
  metadata; it adds no second tracing path.
- `TencentAgentBuilder.fromPreset('tencent-full')`: a replaceable composition
  of Tencent Model/Sandbox/APM plus the standard environment Vault.

The SDK peer `@e2b/code-interpreter` is optional and loaded only when the
sandbox is first used. Live verification is tracked separately from offline
Port conformance; see `recordings/README.md`.
