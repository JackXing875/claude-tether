# 兼容性与验证边界

记录日期：2026-10-23（Asia/Shanghai）。本项目版本 0.1.0-alpha.1，协议 1.0。

| 组件/平台                 | 证据                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                   | 本地和 VPS 均运行 v24.14.0                                                                                                                                              |
| TypeScript                | 固定 6.0.3，与 typed ESLint 兼容，严格类型检查与构建                                                                                                                    |
| ws / zod / MCP SDK / diff | 8.22.0 / 4.6.7 / 1.32.1 / 8.0.4；lockfile                                                                                                                               |
| 本地                      | Linux x64 / WSL2；真实文件、命令、进程组、SQLite、WebSocket/WSS 测试                                                                                                    |
| VPS                       | Ubuntu 26.04.1 x64；1 核、约 950 MiB RAM、约 2.3 GiB swap                                                                                                               |
| 官方 Claude Code          | 两端 2.1.267；VPS 经官方安装器安装，版本检查通过                                                                                                                        |
| 真实订阅请求              | 官方 Pro / claude.ai 两轮 P0 及 VPS → WSL 真实任务已通过，见 [真实报告](LIVE-TEST-REPORT.md)                                                                            |
| MCP                       | 官方 SDK 的 tools/list、tools/call 与本地执行端集成通过；候选 supervisor → MCP 子进程 → relay → 本地执行链路已使用替身 CLI 验证；官方 Claude 的真实调用亦已通过受控验收 |
| CLI NDJSON                | 合成 fixture 用于 CI；真实官方流通过同一 decoder 校验，未保存原始 NDJSON 到仓库                                                                                         |
| Windows 原生              | 未实现/未验收；通过 Windows SSH 连接 VPS 不等于客户端支持 Windows                                                                                                       |
| GitHub CI                 | GitHub main 的初始 CI 已通过；当前工程化改动以对应提交的 Actions 结果为准，见 [测试说明](TESTING.md)                                                                    |

| 功能                       | 当前支持                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------- |
| 文字/流事件                | Fake Agent 与真实官方文本流均验收；无完整 TUI                                      |
| 文件读/搜/改               | 普通 UTF-8 文件 ≤128 KiB；支持空格/Unicode/BOM/CRLF；搜索为 literal                |
| 文件链接/编码              | 拒绝 symlink、binary、UTF-16；不支持 junction 的 Windows 语义                      |
| 权限                       | 本地单次批准、拒绝、超时、只读；CLI 非交互输入默认拒绝副作用                       |
| 命令                       | exec、参数数组、继承本地环境、前台 ≤60 秒、输出 ≤64 KiB                            |
| 命令取消                   | Linux 同进程组 SIGTERM→SIGKILL；主动 setsid 脱离的进程不在已验证边界内             |
| 重复执行                   | 稳定 operation_id 去重；同 ID 改参数拒绝；UNKNOWN 阻止新副作用                     |
| 恢复                       | `sessions` 查询原设备/项目/策略的会话；显式选择 ID、结果对账、epoch 和有限事件补发 |
| 自动重连/持久 UI           | 未完成；UI 与 host 同进程，关闭会停止前台任务                                      |
| 文件撤销/跨 host 文件锁    | 未完成；使用同一 journal 的本地操作串行，外部进程竞争不构成强事务                  |
| hooks/skills/CLAUDE.md/IDE | 本地兼容层未实现；不上传执行脚本到 VPS 自动运行                                    |

P0/P1 的受控真实链路已通过；`server --runtime claude` 与客户端 `--ssh` 可用于 Linux/WSL 的个人 alpha。systemd 模板负责服务生命周期。长期稳定性、自动重连和完整恢复 UI 仍未完成；不要将本轮短任务推广为生产可靠性结论。
