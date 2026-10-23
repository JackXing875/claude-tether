# 兼容性与验证边界

记录日期：2026-10-23（Asia/Shanghai）。本项目版本 0.1.0-alpha.1，协议 1.0。

| 组件/平台                 | 证据                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                   | 本地和 VPS 均运行 v24.14.0                                                                                                                                      |
| TypeScript                | 固定 6.0.3，与 typed ESLint 兼容，严格类型检查与构建                                                                                                            |
| ws / zod / MCP SDK / diff | 8.22.0 / 4.6.7 / 1.32.1 / 8.0.4；lockfile                                                                                                                       |
| 本地                      | Linux x64 / WSL2；真实文件、命令、进程组、SQLite、WebSocket/WSS 测试                                                                                            |
| VPS                       | Ubuntu 26.04.1 x64；1 核、约 950 MiB RAM、约 2.3 GiB swap                                                                                                       |
| 官方 Claude Code          | 两端 2.1.267；VPS 经官方安装器安装，版本检查通过                                                                                                                |
| 真实订阅请求              | 未运行；用户要求稍后登录                                                                                                                                        |
| MCP                       | 官方 SDK 的 tools/list、tools/call 与本地执行端集成通过；候选 supervisor → MCP 子进程 → relay → 本地执行链路已使用替身 CLI 验证；官方 Claude 的真实调用仍待验证 |
| CLI NDJSON                | 自建合成 fixture 通过；没有将其冒充官方实录                                                                                                                     |
| Windows 原生              | 未实现/未验收；通过 Windows SSH 连接 VPS 不等于客户端支持 Windows                                                                                               |
| GitHub CI                 | GitHub main 的初始 CI 已通过；当前工程化改动以对应提交的 Actions 结果为准，见 [测试说明](TESTING.md)                                                            |

| 功能                       | 当前支持                                                               |
| -------------------------- | ---------------------------------------------------------------------- |
| 文字/流事件                | Fake Agent 流式事件；真实模型流未验收                                  |
| 文件读/搜/改               | 普通 UTF-8 文件 ≤128 KiB；支持空格/Unicode/BOM/CRLF；搜索为 literal    |
| 文件链接/编码              | 拒绝 symlink、binary、UTF-16；不支持 junction 的 Windows 语义          |
| 权限                       | 本地单次批准、拒绝、超时、只读；CLI 非交互输入默认拒绝副作用           |
| 命令                       | exec、参数数组、继承本地环境、前台 ≤60 秒、输出 ≤64 KiB                |
| 命令取消                   | Linux 同进程组 SIGTERM→SIGKILL；主动 setsid 脱离的进程不在已验证边界内 |
| 重复执行                   | 稳定 operation_id 去重；同 ID 改参数拒绝；UNKNOWN 阻止新副作用         |
| 恢复                       | 手动指定 session、原 workspace、结果对账、epoch 和有限事件补发         |
| 自动重连/持久 UI           | 未完成；UI 与 host 同进程，关闭会停止前台任务                          |
| 文件撤销/跨 host 文件锁    | 未完成；使用同一 journal 的本地操作串行，外部进程竞争不构成强事务      |
| hooks/skills/CLAUDE.md/IDE | 本地兼容层未实现；不上传执行脚本到 VPS 自动运行                        |

原型成功仅证明工程基础。P0 的退出条件、P1 的真实 Claude 端到端退出条件以及 START.md 24.6 的第一版完成定义尚未达到。
