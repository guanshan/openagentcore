# ADR 0012：不透明凭证代理、执行期注入与审计

- 状态：已采纳（2026-08-12）
- 目标里程碑：M2-3（VaultPort 与第一家云）
- 延续：[ADR 0011](0011-durable-store-and-trace.md)

## 背景

`VaultPort.issue(scope)` 不能仅返回一个字符串。环境变量和加密文件通常保存厂商长期 key；如果把该字符串作为所谓“短期凭证”交给工具，只是给长期密钥换了名字，工具仍可通过反射、序列化、事件或 trace 泄漏它。

同时，凭证使用发生在工具副作用之前，必须和 permission、tool call/result 一样进入可恢复事件流。把审计留给 provider 日志会丢失 session、step 和 call 的稳定关联，也无法由 conformance 统一验证。

## 决策

1. `VaultPort.issue(scope)` 返回 `ShortLivedCredential` 不透明能力对象。公开字段只有 audit-safe scope、`expiresAt` 和 `refreshAfter`；工具只能调用代理的 `request()`，不能读取认证 material。
2. `CredentialScope` 固定允许的 URL 前缀、HTTP method 和受管认证 header。代理在内部注入认证值，拒绝跨 scope 目标、调用方自带受管 header、redirect、过期或已释放的请求。首版只标准化 HTTP 请求代理；其他签名协议不能伪装成 HTTP，需后续扩展 Port。
3. 环境变量与 AES-256-GCM 文件实现签发的是进程内短期 capability lease。lease 到期后停止工作并可刷新，但不会谎称已改变上游静态 key 的真实生命周期。工具永远拿不到该静态值。云 KMS 通过 `KmsCredentialIssuer` 预留接口返回厂商实际短期值，本任务不实现具体 KMS。
4. `withCredential(scope)` 使用模块私有 `WeakMap` 保存被装饰工具与 scope，不把 Vault、原始工具或认证 material 挂到可反射对象上。AgentLoop 在每次实际执行（包括重试）时签发 lease，调用后在 `finally` 中释放。
5. 签发成功后、工具副作用前写入 `credential.used`，字段仅含 `stepId`、`callId`、tool、scope 和 attempt。Trace 只把 scope/attempt 加到已有 `execute_tool` span，不新增厂商埋点，也不记录 expiry、header 或认证值。
6. `vault` conformance 卷验证有限过期时间、刷新使旧代理失效、scope 隔离、认证请求可用，以及反射/序列化结果不含动态生成的敏感值。conformance 自身对失败消息再次按该动态值脱敏。

## 后果

- LLM 可调用的工具只持有最小 scope 的短期 capability；长期 key 只存在于 host-side adapter 的私有状态或短暂解密缓冲区。
- 环境变量与加密文件能作为零服务依赖的默认实现，但它们不能提供上游撤销保证；需要真实短期 token 的部署应使用 KMS issuer。
- HTTP 代理牺牲了任意 SDK 注入的便利，换取可审计的 target/method 边界。厂商 SDK 仍可在可信 provider adapter 内使用自己的凭证，不能把 SDK client 当作工具依赖暴露。

## 开放问题

1. SigV4、TC3-HMAC 等非 Bearer 签名是否扩展为新的 credential operation，需由第二家云的真实数据决定。
2. 跨进程主动撤销和 lease 单次使用语义需要外部 Vault/KMS 的真实接口后再定。
3. 目标服务若在响应正文中回显认证 header，通用代理无法理解业务 payload；provider 应禁用该行为，未来可增加显式响应脱敏策略。
