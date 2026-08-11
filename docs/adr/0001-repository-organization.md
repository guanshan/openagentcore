# ADR 0001：仓库与目录组织

- 状态：已采纳（2026-08-11）
- 详细论证：[design.md §16](../design.md)

## 背景

项目要对接多家云厂商，可预见的膨胀主要来自 provider 数量增长；同时维护 TS 与 Python 双 SDK，存在协议漂移风险。需要在第一天定下目录组织，避免后期返工。

## 决策

1. **两个仓，不是三个**：TS 与 Python 各一仓；spec 不单独成仓，作为 TS 仓顶层 `spec/` 目录维护、独立发版，Python 仓按版本号锁定拉取。出现第三方语言实现时再拆仓。
2. **顶层六个目录，一个生长轴**：`spec / packages / providers / examples / docs` + 根配置。`packages/` 五件套（kernel / coding / runtime / ui / cli）长期固定；一切厂商适配进 `providers/`。
3. **provider 按厂商分包，按 Port 分子路径**：`@openagentcore/tencent` + subpath export（`/model` `/sandbox` …），重依赖走 peerDependencies。否决"一 Port 一包"（包数爆炸）与"单一巨包"（依赖污染）。
4. **Python 镜像目录结构、不镜像包数**：按厂商切 distribution（依赖隔离硬需求），kernel 与 coding 合并为一个 `openagentcore` 包（教训取自 langchain 巨包 extras 的依赖冲突失控）。

## 后果

- 新增顶层包的成本被有意抬高（需 ADR），换取长期认知负担可控。
- 厂商 SDK 升级影响半径锁死在单个 provider 目录。
- spec 与 TS 参考实现同仓演进，改协议一次 PR；代价是 Python 侧有半个版本的滞后窗口，由一致性测试向量兜底。
