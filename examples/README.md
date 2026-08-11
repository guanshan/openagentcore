# examples

可运行示例，只允许 import 公开 API——CI 全量运行，兼作公开 API 的回归测试。

- `replay-demo`：验证内存投影在中断后可由快照与事件流重建。
- `minimal-agent`：使用 `ScriptedModelPort` 与测试工具运行一个包含工具调用的完整 Turn。
- `context-dry-run`：展示 Prompt 覆盖、工具定义与 token 统计，但不发起模型流请求。

构建后运行全部示例：

```bash
pnpm build
pnpm examples
```

也可分别运行：

```bash
pnpm example:replay
pnpm example:minimal
pnpm example:context
```
