# 首轮原型测试报告

日期：2026-10-23（Asia/Shanghai）。代码版本：0.1.0。测试区分本地执行、真实网络、模拟 Agent 与官方运行时；本报告不是第一版验收结论。

## 本地自动化

最后一轮 npm test 退出码为 0，37 项通过，0 失败/跳过。包含严格 TypeScript 构建。该轮测试耗时约 2.8 秒，仅作为执行记录。

| 组 | 数量 | 覆盖的实际行为 |
| --- | --- | --- |
| bridge.test.ts | 8 | 真实 WebSocket 闭环、认证/设备/版本拒绝、会话恢复、丢失结果对账、吊销、控制连接唯一性、WSS 证书校验、禁用公网明文 |
| local-host.test.ts | 15 | UTF-8/BOM/CRLF、编辑后核对、拒绝/超时/只读、路径和编码限制、并发重复投递、参数篡改、绑定、冲突、环境和输出、忽略规则、独占状态库 |
| recovery.test.ts | 4 | 子进程硬退出的崩溃窗口、重开 SQLite 后取回结果、进程组与忽略 SIGTERM 的子进程取消、命令超时 |
| runtime.test.ts | 4 | 候选启动参数、认证环境拒绝、分片 UTF-8 NDJSON 和显示去重、缺失终态/错误工具清单/会话错配 |
| mcp.test.ts | 1 | 使用真正 MCP SDK 的 tools/list 和 tools/call，到本地批准/拒绝边界 |
| limits.test.ts | 4 | 文件上限、不支持的执行标志、workspace 替换、终端控制序列 |
| events.test.ts | 1 | 保留窗口失效检测，避免将其他会话占用的 cursor 误判为丢失 |

故障测试中，命令已经写入本地文件但响应没有传回，恢复后读取 journal 并对账，文件只被写入一次。另一个测试在副作用后、结果持久化前直接结束进程，重启后进入 UNKNOWN，并阻止换新 operation_id 继续产生副作用。

npm audit --omit=dev 退出码 0，报告 0 vulnerabilities。测试期间发现的 diff 8.0.2 依赖告警已通过固定到 8.0.4 修复；终端 OSC 处理问题也已修复并加入回归测试。

## 真实 VPS 网络闭环

实际通过用户授权的 VPS 运行 Fake Agent 服务，用 SSH 加密隧道连接本地 WSL 客户端。没有使用 Claude 模型，也没有消耗订阅请求。

验收：

- 模拟服务以 claude-relay 非 root 账号运行。
- 临时项目只创建在本地：calc.mjs 和 calc.test.mjs。
- 读取、修改、执行本地 Node 测试三项操作均持久记录为 SUCCEEDED。
- 本地函数从减法改为加法；测试退出码 0；收到 7 条业务事件。
- 检查远端程序目录及运行账号目录，未出现项目样例文件。
- 单次观察到服务 RSS 约 80 MiB，**仅是 Fake Agent 服务**，不能代表 Claude Code 内存占用。

该验证覆盖实际跨机器调度。WSS/TLS 证书链校验是在独立本地自动化测试中通过，VPS 网络验证使用 SSH 隧道；没有据此声称公网域名/TLS 部署已完成。

最终代码的跨机器 smoke 耗时 2249 ms，输出摘要保存于 [evidence/p1-network-smoke.json](evidence/p1-network-smoke.json)。该时长包含连接与本地测试，不能用于推断模型响应延迟。

## 官方运行时与未运行项

VPS 通过官方安装器安装 Claude Code 2.1.267，并成功运行 --version。Node 24.14.0 归档通过固定官方 SHA-256 校验。

用户选择稍后登录，因此以下均未运行或未通过验收：

- VPS Pro/Max 登录、真实模型请求及订阅计费来源验证。
- 官方 Claude → MCP → supervisor → 本地工具的完整链路。
- 原生工具实际初始化清单、hooks/skills/managed settings 隔离。
- 持续 stream-json stdin、真实取消、多轮会话恢复及认证故障。
- 真实 Claude 的 CPU/内存、延迟、限流和长时间稳定性。
- Windows 原生、PTY、后台任务、IDE、完整 TUI、恢复 UI。
- GitHub Actions 在线执行和公开发布。

runtime.test.ts 的事件是人工构造的契约 fixture，MCP 测试使用官方 SDK 加模拟调用者；二者均不是实际 Claude 账号联调。VPS 约 1 GB 内存低于官方 4 GB 要求，这项资源适用性仍待后续实际验证。[官方系统要求](https://code.claude.com/docs/en/setup#system-requirements)

## 保留与清理

保留专用运行账号、固定版本运行时和 /opt/personal-relay/prototype 程序副本，便于后续 P0。临时模拟服务、SSH 测试隧道、测试设备凭据和临时项目在验证后清理；没有注册常驻服务或开放公网服务端口。普通工程目录只保存代码、文档和依赖锁文件。
