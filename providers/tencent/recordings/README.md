# Tencent live recording status

No recording fixture is committed for M2-3 because this environment did not
provide the Tencent TokenHub or Tencent Agent Runtime credentials required for
a real call.

| Port    | Status     | Missing runtime configuration               |
| ------- | ---------- | ------------------------------------------- |
| Model   | Unverified | `TENCENT_TOKENHUB_API_KEY`                  |
| Sandbox | Unverified | `E2B_API_KEY`, `E2B_DOMAIN`, `AGS_TEMPLATE` |
| Trace   | Unverified | `TENCENT_APM_ENDPOINT`                      |

Offline conformance uses injected protocol clients and is not described as a
cloud recording. A later credentialed run must add sanitized Model and Sandbox
recordings before these rows can be marked verified.
