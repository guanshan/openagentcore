# ADR 0010：SandboxPort、文件系统语义与 Coding 适配边界

- 状态：已采纳（2026-08-12）
- 目标里程碑：M2-1（权限、Sandbox 与 Conformance 地基）
- 关联：[ADR 0009](0009-coding-package-safety-boundaries.md)

## 背景

M1-2 的 Coding 命令与 Git 工具直接创建宿主进程，无法在不修改 Coding 包的前提下切换到 Docker 或云沙箱。与此同时，Permission Strategy 只收到原始 args，不能安全匹配解析后的真实路径和命令可执行名。若每种沙箱自行定义 cwd、文件编码、尺寸与 snapshot 语义，三家云 Provider 会形成互不兼容的事实接口。

## 决策

1. Kernel 定义单一 `SandboxPort`：`exec`、byte-native `fs` 子 Port、可选 `snapshot` / `restore`，所有操作接收 `AbortSignal`。`capabilities.snapshot` 为真时两个 snapshot 方法必须同时存在；虚假声明是契约错误。
2. 沙箱内部路径统一为 POSIX `/workspace` 命名空间。Port 不暴露宿主路径映射；本地实现把它映射到构造时给定的规范仓根，Docker 实现 bind mount 同一仓根，远程实现自行传输。相对路径和 `/workspace` 外路径不是公共契约。
3. FS 以 `Uint8Array` 读写，不在 Port 层猜编码。文本调用方显式使用 UTF-8 编解码；二进制无损透传。实现必须在传输前执行明确的尺寸上限，本地默认单文件 8 MB。当前不提供隐式分块、目录遍历或大文件流；未来需要时扩展 Port，而不是让 Coding 按 Provider 分支。
4. 每次 FS 调用是一个可取消的完整操作；远程延迟由 Adapter 承担，调用方不得依赖本地同步时序。`realpath` 返回沙箱命名空间内的规范路径，用于拒绝 `..` 与软链逃逸。不存在通用原子 compare-and-swap，ADR 0009 的读后 revision 检查继续保留。
5. Kernel 内置 `LocalProcessSandbox` 作为零 npm runtime dependency 的开发实现，但它**不提供隔离**且不声明 snapshot。`@openagentcore/standard` 提供 Docker CLI 实现；它禁用容器网络、只使用已安装镜像、同样不声明 snapshot。Docker Engine/镜像是显式外部前置条件，不是 CI 必备条件。
6. `AgentLoopOptions.sandboxCapabilities` 表达调用方偏好。请求 snapshot 但 Sandbox 未配置或不支持时，Kernel 沿用 Model 能力协商的可观察路径，把降级写入 `model.request.capabilityDowngrades`。声明支持却缺少实现时不降级掩盖，而是失败。
7. Coding 的命令、Git 与 Verifier 只依赖 `SandboxPort`。默认装配 Local，调用方可注入 Docker/云实现；Coding 不导入 Provider、不检查类名或 capability、不为实现写分支。
8. Tool Port 增加可选 `describeAction`。Tool 只解析自身 args 为规范路径/命令材料，Kernel 把完整 `ActionDescriptor` 写入审批事件并交给唯一 Permission Strategy；Coding 仍不拥有 allow/deny 判定。恢复优先复用持久化描述，避免环境变化导致审批漂移。

## 后果

- 本地与远程 Sandbox 共享路径、字节、取消和能力语义，Coding 的 provider 透明性可由同一测试套件验证。
- Docker 的 bind mount 适合本地开发与 conformance，不等于云端传输实现，也不保证强租户隔离；生产威胁模型仍由部署方选择具体 Adapter。
- byte-native FS 避免编码损坏，但文本工具需要显式编解码；超过上限或高延迟操作会明确失败，而非部分成功。
- Sandbox 降级借用现有 `model.request.capabilityDowngrades`，本里程碑不新增 TracePort 或泛化 capability 事件。

## 开放问题

1. 大文件的流式 read/write、分页目录遍历、版本化原子写与跨 Provider 一致的配额错误码，需在真实云 Sandbox 契约到来后用 conformance 数据决定。
2. Docker snapshot 可映射为 commit、volume snapshot 或 CRIU，语义差异很大；在跨实现的恢复标识与生命周期明确前保持不支持。
3. `/workspace` 是否需要多 mount、只读输入与临时输出命名空间，留待 M2-2 的真实 Provider 反馈。
