# 实施决策（2026-10-23）

当前产品定位为[个人 Claude Code 自托管接入与运维工具](PRODUCT.md)。用户要求账号持续可用性优先、保留本地官方客户端，并优先使用 ccproxy；据此调整目标架构。以下决定取代 START.md 原 H1 和自建客户端优先的产品方向，但不表示代码已完成迁移。

| 当前决定        | 结果与边界                                                                              |
| --------------- | --------------------------------------------------------------------------------------- |
| 主 Agent 与界面 | 目标在本地运行官方 Claude Code，由其管理工具、权限和会话；停止以复刻 TUI/斜杠命令为主线 |
| VPS 与 ccproxy  | VPS 托管请求层代理，ccproxy 为优先适配组件；不再要求模型 Agent 主进程在 VPS             |
| Tether 的职责   | 连接启动、配置、版本锁定、诊断、故障处理及升级回退；具体入口待实现                      |
| 保留目标        | 项目文件和命令留在本地；个人官方订阅与官方登录；面向个人自有设备                        |
| 账号持续可用性  | 作为设计优先级；不将请求伪装、固定出口或短期测试当作免封证据                            |
| 现有原型        | 保留运行、测试和必要维护，不自动迁移状态、停服务或复用旧会话到原生 CLI                  |
| 交付状态        | ccproxy 仅完成源码与文档调研；依赖、部署和原生链路尚未集成、验收                        |

新路线的验收见[路线图](ROADMAP.md)，选型依据见[调研](NATIVE-CLAUDE-RESEARCH.md)。

## 已实现远端 Agent 原型的决策

下表说明现有代码的实现约束，不作为新路线的组件要求。

| 决策        | 本轮选择与原因                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段边界    | 离线 CI 与真实验收分开记录；Pro 的 VPS → WSL 链路现已通过受控验收                                                                        |
| 语言/运行时 | TypeScript 6.0.3 与当前 typed ESLint 兼容；Node.js 24.14+ 的 24.x、npm lockfile；Linux/WSL 优先                                          |
| SQLite      | node:sqlite、WAL、synchronous=FULL；独立 lease 数据库持有 OS 锁，阻止同一状态库被多个执行端同时打开                                      |
| 组件划分    | 核心实现位于 packages，应用只负责组合；导入边界由脚本检查；CLI 和 local-host 同进程，先不引入后台 daemon 与本机 UI IPC                   |
| MCP         | 固定 @modelcontextprotocol/sdk 1.32.1，用维护分支验证 stdio/tool 契约；正式维护前评估 v2 升级                                            |
| 运行时接口  | 一轮一个官方 CLI 进程、明确 --resume UUID；私有 MCP IPC 已通过替身测试及真实 VPS 验收                                                    |
| 远端隔离    | 专用 claude-relay 非 root 账号、独立目录；空内置工具清单、严格 MCP 配置、空 setting-sources、明确工具名称；不使用 --bare                 |
| 文件语义    | 128 KiB UTF-8，保留已有 BOM/CRLF；P1 拒绝全部 symlink，写入前再验证内容 hash；不宣称抵御任意外部进程的路径竞争                           |
| 命令语义    | 仅 exec/前台/非交互，最长 60 秒；不自动启动 shell，不支持 env 覆盖、PTY 或后台标志                                                       |
| 权限        | 默认 ask；read-only 禁止任何命令。accept-edits 仅作为执行端内部可测试策略，暂不在 CLI 暴露                                               |
| 恢复        | 先持久化再执行；同 ID 同参数重放结果；未知结果阻止副作用。新 ID 不能绕过该阻止                                                           |
| 事件        | 服务端持久化有限重放，客户端先持久化事件和游标再渲染；旧游标失效明确报错                                                                 |
| 发布        | 以 JackXing875/claude-tether 为主仓库；沿用用户添加的 GPL-3.0；private 防止误发布 npm；构建带源码的 tarball 并验收安装；不提交状态或凭据 |

不能把单账号、单活动 turn 和小型原型的测试结果推广为稳定生产服务。现有 VPS 约 1 GB 内存，低于官方 4 GB 要求；本轮短任务通过，实际资源观察见 [真实报告](LIVE-TEST-REPORT.md)，尚无长时负载证据。

参考：[CLI 参数](https://code.claude.com/docs/en/cli-reference)、[程序化运行与 bare 模式](https://code.claude.com/docs/en/headless)、[系统要求](https://code.claude.com/docs/en/setup#system-requirements)、[Node 24.14 SQLite](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html)、[MCP 维护分支](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)。
