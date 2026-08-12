# @openagentcore/cli（L4）

`oac` 命令行当前实现 `oac conformance`，按 ModelPort / SandboxPort / StorePort / TracePort 运行可复用的一致性套件：

```bash
oac conformance
oac conformance --format json
oac conformance --json spec/conformance-results.json --matrix docs/capabilities.md
```

人类报告区分 `passed` / `failed` / `skipped`；机器报告使用稳定 JSON Schema version。缺少可选 Docker、MySQL 或 Redis 前置条件时对应 suite 显式 `skipped` 并给出原因，不计作认证通过；任一实际失败使命令退出非零。SQLite 和无网络 OTLP 自证始终实际运行。

第三方 Adapter 可直接引入 `runModelConformance`、`runSandboxConformance`、`runStoreConformance` 或 `runTraceConformance`，传入自己的实例工厂，无需复制官方断言。Store 卷会验证原子 CAS、连续性声明、有限可重复快照和冲突不产生副作用；Trace 卷会验证显式 parent、内容采集声明和 flush。
