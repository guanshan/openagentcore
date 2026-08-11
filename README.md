# OpenAgentCore

开源的、分层的 Agent 基建组合层（Infra Composition Layer）——自由组合各家 LLM / Sandbox / 网关 / 可观测 / 中间件产品（腾讯云、阿里云、火山引擎、知名开源组件），在其上快速做出生产级 Coding Agent 产品：嵌入式 App、客户端产品或后台 Server。

> **状态：设计阶段。** 完整设计见 [docs/design.md](docs/design.md)，尚无可用代码。

## 为什么是它

- **组合优于绑定**：各家基建以统一 Port 抽象接入，`preset` 一行切换整族基建，跨家混搭。
- **事件溯源内核**：崩溃恢复、时间回溯、确定性回放、审计，是同一个存储模型的四个副产品。
- **一切策略皆可换、一切 Prompt 皆可见**：压缩/记忆/路由/权限策略按配置切换；内核没有拿不到、改不了的隐藏 Prompt。
- **SDK-first**：无 IO 依赖的 Kernel 可嵌入任何进程，零依赖跑通 demo；Server / UI / CLI 是上层独立包。

## 分层与目录

| 目录 | 层 | 内容 |
| --- | --- | --- |
| [spec/](spec/) | L0 | 语言无关协议：事件流、工具 Schema、Trajectory、UI 线协议 |
| [packages/kernel/](packages/kernel/) | L1 | 事件溯源 Agent Loop、Strategy/Middleware/Prompt 三机制、Port 接口 |
| [packages/coding/](packages/coding/) | — | Coding Agent 能力包（代码理解、Git 工作流、验证闭环） |
| [packages/runtime/](packages/runtime/) | L3 | HTTP/WS、A2A、MCP server、任务队列、触发器、多租户 |
| [packages/ui/](packages/ui/) · [packages/cli/](packages/cli/) | L4 | React UI Kit 与 `oac` 命令行 |
| [providers/](providers/) | L2 | 各厂商适配器，本仓唯一的生长轴 |

Python SDK 位于独立仓库 [openagentcore-py](https://github.com/guanshan/openagentcore-py)，镜像本仓目录结构、共享 spec。

## 参与

阅读 [CONTRIBUTING.md](CONTRIBUTING.md)（含防膨胀公约）；架构决策记录在 [docs/adr/](docs/adr/)。

## License

[Apache-2.0](LICENSE)
