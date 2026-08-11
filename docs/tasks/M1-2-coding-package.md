# 任务 M1-2：模型流重试的现实化 + Coding 能力包

M1-1 让内核第一次接上了真实模型，也如实暴露了一个真问题（ADR 0007 开放问题 1）。本任务先修它，再做 Coding Agent 的能力包——M1 里程碑的验收目标是「在真实仓库完成一次改代码→跑测试→提交的闭环，中断后恢复续跑」。

开工前通读 `docs/adr/0006`、`docs/adr/0007`、`docs/design.md` §6.4。

## P0 — 模型流重试对真实模型不可用

ADR 0006 要求重试输出逐 code point 复现已持久化前缀，否则抛不变量错误。**实测**：模拟一次连接闪断后重试给出措辞略有不同的输出（`The answer is ` → `The answer would be `），得到

```text
AgentLoopInvariantError: Retried model output diverged from the persisted prefix
for turn-0:step:1:request at atom 11; received text.
```

真实模型 temperature > 0 时，分叉是**常态而非边缘情况**。当前设计把一次可恢复的网络抖动变成了硬失败，比不重试更糟。ADR 0007 已诚实记录该问题且没有在 provider 里打补丁掩盖，这是对的；现在要给出结论。

**方向（可讨论，但要给出决定并写进 ADR）**：分叉不是错误，是事实，应当**显式建模**而不是禁止。

1. 新增事件表达"此前的部分输出被作废、该步重新开始"（如 `model.attempt.discarded`，携带被作废的 delta 区间与原因）。消息投影折叠被作废的 delta——与 compaction 折叠内容的机制同源，注意复用而非另造一套。
2. 重试默认走「作废重来」，事件流保留完整审计痕迹（原始 delta 仍在日志里，只是不进入投影）。
3. 严格前缀模式降级为**可选**，用于确定性场景（回放、temperature = 0、结构化输出）。配置项要能表达这个选择。
4. 回归测试直接用上面那个复现场景：闪断 + 措辞不同的重试，turn 应正常完成。

## P1 — packages/coding（M1 的主体）

design.md §6.4 的能力包。**不进 kernel**，保持内核领域无关。本任务先做能撑起验收闭环的最小集：

1. **文件工具**：读、精确字符串替换编辑、patch 应用、glob/grep 检索。编辑要有冲突检测（读取后文件被改动则拒绝写入），错误信息要指明冲突位置。
2. **执行工具**：跑命令并捕获 stdout/stderr/退出码。**退出码非零是结果失败**（`outcome: 'failed'`），不是执行失败——这正是 M0-3 那套语义存在的理由，别用抛异常表达测试没通过。
3. **Git 工作流**：分支创建、diff 读取、commit。worktree 隔离留接口即可，本任务不必实现完整并行隔离。
4. **验证闭环**：`Verifier` 接口（跑测试/lint/构建并归一化结果），让"改完自己验证"成为循环里可编程的一步而不是靠 prompt 祈祷。
5. **安全默认**：危险命令识别、路径白名单、默认拒绝仓库外写入。权限描述要接上 M0-2 的 permission 策略，不要另造一套判定。

## P2 — 真实仓库闭环验收

在一个真实的小型仓库（可以是本仓自身或专门造的 fixture 仓）上跑通：

```text
接到任务 → 读代码 → 改代码 → 跑测试（失败）→ 读错误 → 再改 → 测试通过 → 提交
```

- 用 M1-1 的 Record & Replay 录制一次真实模型的完整闭环，回放版本进 CI（CI 仍不得有真实网络调用）。
- **中途中断 + 恢复续跑**也要在这个闭环上验证一次：在跑测试那一步中断，恢复后继续完成并提交。这是 M0 崩溃恢复能力在真实工作负载上的兑现。

## 约束与护栏

- **不做**：Sandbox provider（本任务用本地进程执行）、腾讯/阿里/火山适配器、Runtime/Server、UI、CLI 完整形态。
- `packages/coding` 是 `packages/` 既有成员，不新增顶层包；kernel 保持零 runtime dependencies。
- Coding 工具的权限描述必须复用 M0-2 的 permission 策略机制；发现该机制表达力不足，记 Open Question 或 ADR，**不要在 coding 包里另立一套判定**。
- 真实仓库操作的测试必须在临时目录的 fixture 仓里进行，不得改动本仓工作树。

## 验收

- P0 的复现场景（闪断 + 措辞不同的重试）turn 正常完成；严格前缀模式仍可显式开启并有测试。
- 文件编辑的冲突检测、退出码非零映射为结果失败、危险命令拦截各有测试。
- 真实仓库闭环的回放版本在 CI 中通过；中断恢复续跑有测试。
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm examples` 全绿，CI 无真实网络调用。

## 工作方式

新分支 `feat/m1-2-coding-package`，小步 commit，PR 描述含 Decisions / Open Questions / 验收逐条勾选，并附 `git log --oneline` 与 head SHA。
