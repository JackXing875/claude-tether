# 0.3 网络隔离与 ccproxy 接口验收

日期：2026-10-23（Asia/Shanghai）。在 `27ddf6309ede32eb5a71304ab46346d6c488d94c` 基础上实现 `0.3.0-beta.1`。本页记录新版测试；[0.2 报告](LIVE-TEST-REPORT.md)保留历史结果。[脱敏证据](evidence/isolated-live-2026-10-23.json)不包含账号标识、服务器地址、凭据或会话原文。

## 结果

默认网络隔离已通过本地自动化和真实 Pro 调用。它把 Claude 及普通 Linux 子进程限制在仅有 loopback 的网络命名空间：支持代理的 HTTP(S) 经过 SSH/VPS，其他外部 IP 连接被阻止。它不是所有协议都能透明工作的 VPN，也不是针对恶意代码的文件系统沙箱。

| 验证 | 结果 |
| --- | --- |
| 官方 Pro / Sonnet 任务 | 成功；58.787 秒，129 个流式事件，Glob、Read、Edit、Bash、本地 MCP 实际执行 |
| CLAUDE.md / hooks / MCP | 项目标记正确；SessionStart/PostToolUse 正常；随机 MCP 挑战值正确 |
| 项目测试 | 修复临时加法实现，2 项本地断言通过 |
| Opus 恢复同一会话 | 成功；17.257 秒，11 个流式事件；不调用工具，准确回忆前文标记和随机值 |
| 原生 TUI `/model` | 菜单正常打开，取消菜单后 `/exit` 退出码 0 |
| 官方 CLI 项目代理覆盖 | 另一主机代理收到 0 次 CONNECT；目标 HTTPS 服务收到 0 次请求 |
| 官方 CLI `NO_PROXY=*` 覆盖 | 目标 HTTPS 服务收到 0 次请求；无法恢复 0.2 中可行的直接访问 |
| 子进程网络约束 | IPv4、IPv6、UDP 直接访问返回 ENETUNREACH；外部 DNS 不可达；主机 loopback 服务不能直连 |
| HTTP 与 SSH | 网络隔离内的 HTTP 通过真实本地 SSH fixture 成功；原有 TLS/SSE、重连及不重放测试继续通过 |
| 强制终止 | SIGTERM/SIGKILL 后隔离内的 detached 工具停止，SSH 退出，启动器管道正常关闭 |
| 自动化与安装 | 29 项测试全部通过；真实 tarball 安装/启动通过；生产依赖审计 0 项漏洞 |

环境为 WSL2 Ubuntu 24.04、Node 24.14.0、bubblewrap 0.9.0、官方 Claude Code 2.1.267。继续使用已验证的 Vultr SSH 出口，无需更换 AWS。Sonnet/Opus 两轮连接跟踪分别记录 76/69 次 loopback 尝试，各 1 次外部连接，均为 SSH 出口。跟踪结果是这两轮的观察证据；强制限制来自网络命名空间配置及专门的绕过测试。

真实任务仍在临时项目中执行，使用用户已完成官方登录的独立 Pro 配置。没有复制 VPS 登录凭据，没有向 ccproxy 发送真实 Pro 凭据。TUI 首次自动化识别因 ANSI 格式而超时；修正测试脚本的终端文本匹配后完成验证，无需修改 Claude。

## ccproxy 验证和决定

`--ccproxy-port` 已实现：本机 loopback 网关通过 SSH 连接 VPS 的 `127.0.0.1:<port>`，普通流量继续经 SSH 代理。自动化测试验证模型、beta/auth 头、工具 SSE 增量和 429/Retry-After 保留。

另外，安装了 `starbaser/ccproxy` 提交 `f2c47695b0835da023257aee0ac2a3dffd9fe570`，在只有 loopback 的独立命名空间中连接本地虚拟上游。两种模型名、工具和 metadata 请求体、Bearer 头、SSE 原文、count_tokens 与 429 返回均通过。使用的全部凭据均为测试字符串；[依赖快照](evidence/ccproxy-synthetic-constraints.txt)和仓库内 `scripts/test-ccproxy.mjs` 支持复现。

此次测试实际生成了 `tls.keylog`、`wg.keylog`；关闭普通日志不能关闭这些输出。源码还显示上游 TLS 验证默认关闭、Inspector 留存请求，以及 `host` 字段不足以证明监听仅在 loopback。详细证据和边界见 [ccproxy 说明](CCPROXY.md)。因此本次不在 VPS 部署 ccproxy，不把它接入日常 Pro 入口；连接器保持实验性、默认关闭。身份伪装没有启用，也没有防封结论。

## 修复和剩余范围

修复了可覆盖代理后的直接出网、强制退出后遗留 SSH 子进程、普通 HTTP 不支持、旧构建产物残留和安装包缺失引用文档。大上传在桥接建立期间使用背压等待，不能因为超过小缓冲区就直接拒绝。

尚未验证：长时间连续编码、生成中的真实模型流遭遇断网、官方 CLI 升级、macOS/Windows 原生，以及真实 Pro 经过 ccproxy。网络命名空间可能影响主机本地服务、Windows 程序和嵌套沙箱；这些是明确的兼容性边界。全机器 TCP/UDP VPN 不属于本次实现。
