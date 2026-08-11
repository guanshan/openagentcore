# 任务 M0-1R2：折叠摘要定位语义的收尾

第二轮 review（2026-08-11）结论。上一轮 14 项大部分到位，ADR 0002 与 EventLog 契约收紧质量良好，无需返工。本轮只剩 4 项，核心是 P0-1 未修彻底。

## P0 — 折叠摘要仍会乱序（根因是语义未定，不是补丁问题）

`projectionPosition` 把 `Math.min` 改成 `Math.max` 只是把错误方向翻了个面。执行复现（探针已验证）：

```text
delta 0 'A' · delta 1 'B' · delta 2 'C'（同一 stepId）
compaction 3 折叠 1..1  → S1 覆盖 [[1,1]]，位置 1，历史 [A, S1, C] ✅
compaction 4 折叠 3..3  → S2 覆盖 [[1,1],[3,3]]，位置 max=3
实际结果：[assistant "AC"(sourceSeqs 0,2), summary S2]
```

两个错：覆盖 seq 1 的摘要跑到了 seq 2 消息之后；A 与 C 因摘要让位而**合并成一条连续 assistant 消息**，压缩边界被彻底抹掉。spec/README 新增的"时间一致性"声明在 `representedRanges` 非连续时不成立。

**根因**：`representedRanges` 把两类东西混在一起——被摘要掉的**内容事件**区间，和被折叠的**compaction 事件自身的 seq**（元事件）。上例中 `[3,3]` 是 S1 这条 compaction 事件的 seq，不是内容；用它参与定位自然把摘要推到了错误位置。

**要求的修法（两步，缺一不可）**：

1. **区分内容覆盖与元事件覆盖**。摘要条目分别记录 `contentRanges`（真正被折叠的内容事件）与被折叠的 compaction 事件 seq。定位与物化输出**只依据 `contentRanges`**；判断连续性时元事件 seq 视为"透明"（可跨越）。上例中 S2 的内容覆盖是 `[[1,1]]`，位置回到 1，历史恢复为 `[A, S1', C]`，A/C 不再合并。
2. **拒绝真正非连续的内容覆盖**。存在无法正确定位的情形：`A(0) B(1) c(2,drops 0) C(3) c(4,drops 2..3)` 使内容覆盖为 `[[0,0],[3,3]]`，而 B(1) 夹在中间——无论取 min 还是 max 都是错的。此时应与既有的"部分重叠"一样抛 `ProjectionInvariantError`。语义定为：**一次 compaction 的有效内容覆盖必须连续（元事件透明）**，这符合真实压缩总是折叠一段连续对话窗口的直觉。

语义先写进 `spec/README.md` 再实现；两种情形（正确重定位、非连续拒绝）各补回归测试；新增 `invalid-replay-noncontiguous-coverage.json` 向量。

## P1 — 不变量与别名

1. `projection.ts:250` — `representedRanges.every(...)` 对空数组恒真，任何 compaction 都会静默删除一个空区间摘要（已确认条目凭空消失），且 `projectionPosition` 会得到 `-Infinity`。空 `representedRanges` 经未校验的 `initialState`（快照恢复路径）可达。构造摘要条目时校验非空，恢复路径校验 `initialState`。
2. `projection.ts:364` — `materializeEntry` 克隆了 `representedRanges` 却把 `dropped` 按引用返回（别名到调用方的 `event.dropped`）；`finalizeMessageProjection` 的 `Object.freeze` 是浅冻结，外部改 `history[i].dropped` 会污染投影状态与后续 compaction 校验。一并深冻结或克隆。

## P2 — 自检探针污染工作树

`prettier.config.test.mjs` 与 `dependency-cruiser.config.test.mjs` 用 `wx` 把探针文件写进工作树、仅在 `finally` 清理，且路径不在 `.gitignore`。测试被中断（Ctrl-C、CI 超时）就会残留 `format-self-test-probe.json`：此后 `pnpm lint` 永久失败，且每次重跑都因 EEXIST 失败。改为写入 `os.tmpdir()` 下的临时目录；确需在仓库内的（depcruise 需要真实包路径），把探针文件名加入 `.gitignore` 并在测试启动前先清理残留。

## 验收

- P0 两步语义各有回归测试，且上文两个复现序列均为测试用例；`spec/README.md` 的时间一致性声明与实现一致。
- P1 两项各有回归测试（空区间摘要被拒、物化结果被冻结/克隆不可污染源状态）。
- 中断模拟：探针测试中途 kill 后 `pnpm lint` 仍绿。
- 全绿：`pnpm lint && pnpm typecheck && pnpm test && pnpm build`。
