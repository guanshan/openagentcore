# ADR 0009：Coding 能力包的权限与安全边界

- 状态：已采纳（2026-08-11）
- 目标里程碑：M1-2（Coding 能力包）

## 背景

`@openagentcore/coding` 需要文件写入、进程执行和 Git 状态变更，同时必须保持 Kernel 领域无关。M0-2 已把授权决策定义为 Permission Strategy：Tool 只声明 permission，AgentLoop 负责写入审批事件并调用所选策略。

路径边界、乐观并发冲突和少量无条件禁止的宿主破坏命令又属于执行适配器必须维持的安全前置条件。把这些条件实现成 Coding 私有的 allow/deny 规则引擎会与 Kernel 策略产生双重判定和配置漂移。

## 决策

1. Coding 工具直接实现 Kernel `Tool`，并通过 `Tool.permission.kind` 声明 `filesystem-read`、`filesystem-write`、`process-execute`、`repository-read` 或 `repository-write`。AgentLoop 的 Permission Strategy 是唯一授权判定入口；Coding 包不实现策略文件、审批状态或 allow/deny 注册表。
2. 工具按 `coding/read`、`coding/write`、`coding/execute` 和 `coding/git` 注册进既有 `ToolRegistry` group，使 M0-2 的 tool/group/permission-kind 规则可以直接选择它们。
3. RepositoryWorkspace 把路径约束在构造时给定的仓根内，并解析已有文件与父目录的真实路径以拒绝符号链接逃逸。仓外写入无配置时始终拒绝。
4. 写工具要求同一 Workspace 已读过目标文件；写入前重新读取并比较内容 revision。变化时返回带 path、line、column 的冲突结果，不覆盖外部修改。
5. `coding.run-command` 的非零退出码是 `{ outcome: 'failed' }` 的业务结果；进程无法创建或调用方取消才是执行异常。固定危险命令识别只拦截递归强删、破坏性 Git 清理、磁盘/电源操作等宿主级破坏行为，它是不可放宽的执行前置条件，不是第二套授权策略。
6. Git commit 只暂存调用方显式列出的路径。Worktree 隔离本次只定义接口，不实现并行生命周期管理。

## 后果

- Coding 包可由 Kernel 的现有 Permission Strategy、审批事件和恢复流程统一治理，不需要 Kernel 导入任何领域代码。
- 文件冲突、测试失败和危险命令拦截都能以结构化工具结果回喂模型；真正的执行故障仍沿用 M0-3 错误反馈语义。
- 本地进程不是 Sandbox provider；部署方仍需在进程、容器或主机层提供适合其威胁模型的隔离。

## 开放问题

1. M0-2 内置 `policy-file` 目前只能匹配 tool、group 和 permission kind，尚不能声明 path glob、命令模式或参数约束。Coding 工具会把完整 args 与 permission 一起交给 Strategy，外部策略已经可以检查这些字段；公共规则语法如何扩展需在 Kernel Strategy 中统一设计，不能在 Coding 包内先造一套。
2. 文件系统没有通用原子 compare-and-swap。当前 revision 检查缩小但不能消除检查与写入之间的竞态；Sandbox/Store provider 后续是否提供版本化写契约仍未决定。
