# 任务 M2-1：权限表达力 + SandboxPort + Conformance Suite

M1 已经能在真实仓库跑通闭环。进入 M2（国内云 Providers）之前，有三块地基必须先补——否则三家云适配器会各写各的、无从验收。

开工前通读 `docs/adr/0009`、`docs/design.md` §7.1、§10、§13.1。

## P0 — Permission 策略的表达力（M1-2 遗留，已阻塞真实使用）

当前 `PolicyRule` 只能匹配 `tool` / `group` / `permissionKind`，无法表达路径与命令维度。这意味着权限只能按工具整体开关——一个 Coding Agent 要么不能写文件，要么能写任何文件（包括 `.github/workflows/`、`~/.ssh/`）。这不是可用的安全模型。

M1-2 正确地拒绝了在 coding 包里另立判定（ADR 0009），把问题上交内核，现在解决：

1. `ActionDescriptor` 携带足够的判定材料：工具名、权限 kind、**解析后的绝对路径集合**（读/写分列）、**命令与其解析出的可执行名**。路径必须是解析后的真实路径（含 symlink 解析），防止 `../` 与软链绕过。
2. `PolicyRule` 支持路径 glob 与命令模式匹配，规则语义要明确：首个匹配生效、deny 优先还是顺序优先必须写进 spec/README 并有测试。
3. 规则语法对齐主流 coding agent 的习惯（工具 + 参数模式），不要发明新 DSL。
4. 必须覆盖的测试：允许读 `src/**` 但拒绝写 `.github/**`；允许 `npm test` 但拒绝 `rm`；路径穿越与软链绕过被拒。

## P1 — SandboxPort（M2 的前置）

`packages/kernel/src/ports/` 目前只有 `model.ts`。design.md §2.2 的五个 Port 里，`SandboxPort` 是三家云适配器都要实现的那个，必须先定义。

1. 按 design.md §2.2 定义 `SandboxPort`：`exec`、`fs` 子 Port、可选 `snapshot`/`restore`（能力协商声明），全部支持 `AbortSignal`。
2. **能力协商要诚实**：不支持快照的沙箱如实声明，内核对缺失能力自动降级并把降级事实记入事件流（沿用 M1-1 已建立的做法）。
3. 两个实现：`LocalProcessSandbox`（内核内置的 Null Object 级实现，零依赖）与 `providers/standard` 的 Docker 实现（重依赖走 peerDependencies）。
4. `packages/coding` 的执行工具改为经 `SandboxPort` 执行，不再直接起进程——这样"本地跑"与"云沙箱跑"对 coding 包完全透明。这是本任务对架构的关键验证：**如果 coding 包需要为两种沙箱写分支，说明 Port 抽象错了**。
5. 文件系统语义统一（design.md 附录 A 开放问题 2）：本地 FS 与远程沙箱 FS 的路径映射、编码、大文件与延迟差异如何在 Port 层收敛，给出结论并写 ADR。

## P2 — Conformance Suite v1（design.md §13.1，生态治理的抓手）

没有它，社区贡献的 provider 无法验收，"能力矩阵"也无从自动生成。

1. 按 Port 分卷（`model` / `sandbox`），每卷是一组标准测试：任何第三方 adapter 引入自己的实例即可运行。
2. 测试必须覆盖能力协商的**诚实性**——声明支持某能力就必须真的支持，声明不支持则内核降级路径要能走通。
3. `oac conformance` 作为 CLI 子命令（不另立包），输出人类可读报告 + 机器可读结果。
4. 能力矩阵文档从测试结果**自动生成**，不手工维护。
5. 用现有的 `@openagentcore/standard` model adapter 与两个 sandbox 实现跑通自证。

## 约束与护栏

- **不做**：腾讯/阿里/火山适配器（M2-2）、Runtime/Server、UI、Trace Port 的完整实现。
- kernel 保持零 runtime dependencies；`packages/` 不新增成员；新 provider 目录必须能过 conformance。
- coding 包不得为特定 sandbox 实现写分支；发现 Port 抽象不足，改 Port 并记 ADR。
- CI 不得依赖 Docker 可用：Docker sandbox 的 conformance 在 Docker 不可用时**跳过并显式报告跳过**，不得静默通过。

## 验收

- 四条权限测试（读 `src/**` 允许、写 `.github/**` 拒绝、`npm test` 允许、`rm` 拒绝）通过；路径穿越与软链绕过被拒。
- coding 包在 `LocalProcessSandbox` 与 Docker sandbox 上跑同一套测试，**代码零分支差异**。
- `oac conformance` 对现有 adapter 全绿；能力矩阵自动生成并入库。
- 能力声明不诚实的 adapter（故意造一个）会被 conformance 判红。
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm examples` 全绿，CI 无真实网络、不强依赖 Docker。

## 顺带

M1-2 遗留的"真实模型闭环录制"仍缺一个可用端点。若本任务期间拿到端点配置，补录一份并入库；拿不到就继续显式标记为未完成，不要用合成录制冒充。

## 工作方式

新分支 `feat/m2-1-permission-sandbox-conformance`，小步 commit，PR 描述含 Decisions / Open Questions / 验收逐条勾选，并附 `git log --oneline` 与 head SHA。
