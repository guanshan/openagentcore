# @openagentcore/coding

Kernel 之上的官方 Coding Agent 能力包。M1-2 提供能支撑“读代码 → 编辑 → 验证 → 提交”闭环的最小集合：

- `coding.read-file`、`coding.replace`、`coding.apply-patch`、`coding.glob`、`coding.grep`
- `coding.run-command`
- `coding.git-create-branch`、`coding.git-diff`、`coding.git-commit`
- `Verifier` / `CommandVerifier`，以及待后续实现的 `WorktreeIsolation` 接口

```ts
import { createCodingToolset } from '@openagentcore/coding';

const { registry, workspace, sandbox } = createCodingToolset({ root: '/path/to/repository' });
```

所有工具复用 Kernel 的 `Tool.permission`、`ToolRegistry` 与 Permission Strategy。Coding 包不会读取或判定私有策略文件；它只在 `describeAction` 中把路径解析为真实绝对路径，并解析命令的首个可执行名，交给 Kernel 的 `policy-file` 做 path/command glob 判定。仓库路径边界、读后写冲突和宿主破坏命令拦截仍是不可放宽的执行前置条件。

`coding.run-command`、Git 工具和 `CommandVerifier` 只调用注入的公共 `SandboxPort`，不识别本地或 Docker 实现。`createCodingToolset` 未注入时使用 Kernel 的 `LocalProcessSandbox`；部署方可注入 `DockerSandbox` 或云实现，Coding 源码没有 provider 分支。

文件与 Git 测试只操作系统临时目录内创建的 fixture 仓，不修改 OpenAgentCore 工作树。
集成测试通过 M1-1 `RecordingModelPort` / `ReplayModelPort` 回放完整闭环，并在首次失败验证已执行但结果未持久化的位置模拟进程丢失，恢复后以同一 `callId` 继续到最终提交。CI 的录制源是确定性 `ScriptedModelPort`，不会因环境变量存在而调用真实端点。
