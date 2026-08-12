# OpenAgentCore

开源的、分层的 Agent 基建组合层（Infra Composition Layer）——自由组合各家 LLM / Sandbox / 网关 / 可观测 / 中间件产品（腾讯云、阿里云、火山引擎、知名开源组件），在其上快速做出生产级 Coding Agent 产品：嵌入式 App、客户端产品或后台 Server。

> **状态：M2 Provider 地基阶段。** 已提供事件溯源 AgentLoop、Strategy/Middleware、版本化 Prompt、首个 OpenAI-compatible ModelPort、Record & Replay、细粒度权限 glob、SandboxPort（Local/Docker/Tencent Agent Runtime）、持久化 StorePort（SQLite/MySQL/Redis）、TracePort（Noop/OTLP）、VaultPort（环境变量/加密文件/KMS 接口）、腾讯云 Provider、最小 Coding 闭环，以及 `oac conformance`；腾讯云真实端点录制仍待凭证，Runtime 与 UI 尚未实现。

## 为什么是它

- **组合优于绑定**：各家基建以统一 Port 抽象接入，`preset` 一行切换整族基建，跨家混搭。
- **事件溯源内核**：崩溃恢复、时间回溯、确定性回放、审计，是同一个存储模型的四个副产品。
- **扩展机制可替换**：停止、压缩、权限与重试通过 Strategy 注册；模型、工具、上下文、记忆与事件处理通过 Middleware 组合。
- **SDK-first**：无 IO 依赖的 Kernel 可嵌入任何进程，零依赖跑通 demo；Server / UI / CLI 是上层独立包。

## 分层与目录

| 目录                                                          | 层  | 内容                                                     |
| ------------------------------------------------------------- | --- | -------------------------------------------------------- |
| [spec/](spec/)                                                | L0  | 语言无关协议：事件流、工具 Schema、Trajectory、UI 线协议 |
| [packages/kernel/](packages/kernel/)                          | L1  | AgentLoop、Prompt/Context、Strategy/Middleware、Port     |
| [packages/coding/](packages/coding/)                          | —   | Coding Agent 能力包（文件/执行工具、Git、验证闭环）      |
| [packages/runtime/](packages/runtime/)                        | L3  | HTTP/WS、A2A、MCP server、任务队列、触发器、多租户       |
| [packages/ui/](packages/ui/) · [packages/cli/](packages/cli/) | L4  | React UI Kit 与 `oac` 命令行                             |
| [providers/](providers/)                                      | L2  | 各厂商适配器，本仓唯一的生长轴                           |
| [providers/standard/](providers/standard/)                    | L2  | 通用 Model/Sandbox/Store/Trace Adapter、录制回放与组合根 |
| [providers/tencent/](providers/tencent/)                      | L2  | 腾讯 TokenHub/Agent Runtime/APM Adapter 与组合预设       |

首个真实 Provider 的离线 Facade 与显式实机入口见 [examples/first-real-provider/](examples/first-real-provider/)。

Coding 闭环的 CI 回放在系统临时目录创建独立 fixture Git 仓，覆盖“错误修改 → 验证失败 → 修正 → 验证通过 → 提交”和验证中断后的恢复续跑；SQLite 卷还让子进程真实退出，再由新进程重开数据库续跑。测试不会修改本仓工作树，也不会访问真实模型网络。

`pnpm conformance` 按 Model/Sandbox/Store/Trace/Vault Port 自证现有 Adapter，并明确区分通过、失败和可选前置条件缺失导致的跳过。机器结果与自动生成的能力矩阵分别见 [spec/conformance-results.json](spec/conformance-results.json) 和 [docs/capabilities.md](docs/capabilities.md)。

Python SDK 位于独立仓库 [openagentcore-py](https://github.com/guanshan/openagentcore-py)，镜像本仓目录结构、共享 spec。

## 参与

阅读 [CONTRIBUTING.md](CONTRIBUTING.md)（含防膨胀公约）；架构决策记录在 [docs/adr/](docs/adr/)。

## License

[Apache-2.0](LICENSE)
