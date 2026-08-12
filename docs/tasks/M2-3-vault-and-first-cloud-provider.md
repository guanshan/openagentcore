# 任务 M2-3：VaultPort + 第一家国内云适配器

五个 Port 已有四个（Model / Sandbox / Store / Trace），conformance 四卷就位。本任务补最后一个 Port，并**打通第一家云**——用它验证整套抽象在真实厂商 SDK 上成立，之后另外两家就是有 conformance 兜底的复制工作。

开工前通读 `docs/design.md` §2.2、§7.1、§10、`docs/adr/0011`。

## P0 — VaultPort（design.md §10）

凭证是这个项目安全模型的核心：**agent 永远不应接触长期密钥**。

1. 定义 `VaultPort`：`issue(scope)` 返回短期 scoped 凭证，带过期时间与刷新语义。
2. 三个实现：环境变量（零配置默认）、加密文件、以及云 KMS 的接口预留（本任务不实现具体云）。
3. **`withCredential(scope)` 装饰器**（design.md §5.3）：工具在执行期才向 Vault 换取凭证，用完即弃。工具代码拿到的必须是代理，**永远接触不到长期密钥**——写一个测试证明：即便工具尝试反射/遍历自身依赖，也拿不到原始 key。
4. 审计：事件流记录"谁在哪一步用了什么 scope"，但**永不落密钥明文**。这条要有测试——构造一次带凭证的工具调用，断言事件流与 trace 中都搜不到密钥原文。
5. conformance 增加 `vault` 卷：过期语义、scope 隔离（A scope 的凭证不能访问 B）、密钥不泄漏。

## P1 — 第一家云：腾讯云（Model + Sandbox + Trace）

选一家打通全链路，验证抽象而非堆数量。腾讯云作为第一家（可换，但要在 PR 说明理由）。

1. 新目录 `providers/tencent`，subpath export 分 Port（`/model`、`/sandbox`、`/trace`），厂商 SDK 走 optional peerDependencies，包内消化厂商概念——**厂商类型不得泄漏进 kernel API**（反腐层，design.md §2.2）。
2. Model：优先复用已有的 OpenAI-compatible 逻辑（混元有兼容端点则直接配置化，不要复制代码）；确需原生 SDK 的能力，在包内实现并如实声明 capabilities。
3. Sandbox：对接云沙箱；不支持的能力（如 snapshot）如实声明，让内核走降级。
4. Trace：APM 只是 OTLP exporter 的配置，**不要为它单独设计埋点**——如果发现需要，说明 §12 的抽象有问题，记 ADR。
5. `preset: 'tencent-full'`（design.md §7.2 抽象工厂）：一行切换整族基建，并支持局部覆盖（如模型用火山、其余用腾讯）。跨家混搭要有测试。

## P2 — 真实端点验证

这是本任务与 M1-1 的最大区别：**必须真的连一次**。

- 至少 Model 与 Sandbox 各跑通一次真实调用，录制之，回放版本进 CI。
- 真实调用仍由显式环境变量门控，CI 不得联网。
- 拿不到某个服务的凭证就如实标记未完成——沿用已经用过三次的做法，不要用 mock 冒充真实录制。

## 约束与护栏

- **不做**：阿里云/火山引擎适配器（M2-4，届时应是机械复制）、Runtime/Server、UI。
- `providers/` 是唯一生长轴；`providers/tencent` 必须过 conformance 才算完成。
- **不要为了让厂商适配器好写而放宽 Port 契约**。厂商能力不足时走能力协商降级；Port 抽象确实不够时改 Port 并记 ADR，改动要同步到已有的 standard 实现。
- 密钥不得出现在代码、测试、录制、事件流、trace、日志中的任何一处。

## 验收

- Vault 的三条测试通过：工具拿不到长期密钥、scope 隔离、事件流与 trace 中搜不到密钥原文。
- `preset: 'tencent-full'` 一行装配可跑；跨家混搭（模型换一家）有测试。
- `providers/tencent` 过 conformance；能力矩阵自动更新，未验证的能力不得标为 passed。
- 至少一次真实云调用的录制入库并可回放；未拿到凭证的部分显式标记。
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm examples` 全绿，CI 无真实网络。

## 顺带

真实模型闭环录制（M1-2 遗留）若本任务拿到任一可用端点，一并补录入库。

## 工作方式

新分支 `feat/m2-3-vault-and-tencent`，小步 commit，PR 描述含 Decisions / Open Questions / 验收逐条勾选，并附 `git log --oneline` 与 head SHA。
