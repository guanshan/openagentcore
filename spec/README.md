# spec（L0）

语言无关的协议定义：事件流、工具 Schema、Trajectory 格式、UI 线协议（JSON Schema），以及 conformance 测试向量。

独立发版；Python 仓按版本号锁定拉取。TS 实现为参考实现，先行半个版本。

## 外部协议版本锁定

采标不自造（design.md §2.3）。本目录记录各外部协议的锁定版本，升级走 ADR：

| 协议 | 锁定版本 |
| --- | --- |
| MCP | 2026-07-28 |
| A2A | v1.0 |
| AG-UI | 跟随主线，`oac.*` 扩展事件 schema 在本目录定义 |
