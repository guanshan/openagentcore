# providers（L2）—— 本仓唯一的生长轴

一个厂商一个包，Port 用 subpath export 区分（如 `@openagentcore/tencent/sandbox`）；重依赖声明为 peerDependencies，按需安装。

新 provider 必须通过 `oac conformance` 才能进入本目录；未通过的请先在自己的仓库发布，README 社区列表收录。

无厂商归属的通用适配器（MySQL/Redis/Docker/OpenAI-compatible/OTLP）归入 `standard/`。
