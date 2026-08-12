# @openagentcore/coding

Kernel 之上的官方 Coding Agent 能力包。M1-2 提供能支撑“读代码 → 编辑 → 验证 → 提交”闭环的最小集合：

- `coding.read-file`、`coding.replace`、`coding.apply-patch`、`coding.glob`、`coding.grep`
- `coding.run-command`
- `coding.git-create-branch`、`coding.git-diff`、`coding.git-commit`
- `Verifier` / `CommandVerifier`，以及待后续实现的 `WorktreeIsolation` 接口

```ts
import { createCodingToolset } from '@openagentcore/coding';

const { registry, workspace } = createCodingToolset({ root: '/path/to/repository' });
```

所有工具复用 Kernel 的 `Tool.permission`、`ToolRegistry` 与 Permission Strategy。Coding 包不会读取或判定私有策略文件；仓库路径边界、读后写冲突和宿主破坏命令拦截是固定执行前置条件。内置 `policy-file` 尚不能匹配 path/command glob，具体边界与开放问题见 [ADR 0009](../../docs/adr/0009-coding-package-safety-boundaries.md)。

文件与 Git 测试只操作系统临时目录内创建的 fixture 仓，不修改 OpenAgentCore 工作树。
集成测试通过 M1-1 `RecordingModelPort` / `ReplayModelPort` 回放完整闭环，并在首次失败验证已执行但结果未持久化的位置模拟进程丢失，恢复后以同一 `callId` 继续到最终提交。CI 的录制源是确定性 `ScriptedModelPort`，不会因环境变量存在而调用真实端点。
