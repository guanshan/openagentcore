# @openagentcore/cli（L4）

`oac` 命令行当前实现 `oac conformance`，按 ModelPort / SandboxPort 运行可复用的一致性套件：

```bash
oac conformance
oac conformance --format json
oac conformance --json spec/conformance-results.json --matrix docs/capabilities.md
```

人类报告区分 `passed` / `failed` / `skipped`；机器报告使用稳定 JSON Schema version。缺少可选 Docker Engine 或本地镜像时 Docker suite 显式 `skipped` 并给出原因，不计作认证通过；任一实际失败使命令退出非零。

第三方 Adapter 可直接引入 `runModelConformance` 或 `runSandboxConformance`，传入自己的实例工厂和最小 exec probe，无需复制官方断言。
