# @openagentcore/kernel（L1）

`@openagentcore/kernel` 是无网络与磁盘 IO、运行时依赖为零的事件溯源内核。当前提供 AgentEvent、EventLog、SnapshotStore、消息与 Session 投影、可恢复的 `AgentLoop`、Model/Tool Port、Strategy 注册表及五条 Middleware 管道。

`ScriptedModelPort` 与测试工具用于确定性测试和示例，不包含真实 Provider。Prompt 系统计划在 M0-3 实现；Runtime、UI 与 CLI 位于上层包。
