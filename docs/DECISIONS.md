# 实施决策（2026-10-23）

START.md 的 H1—H5 保持不变：官方主进程在 VPS；个人 Pro/Max；项目操作本地执行；兼容客户端；个人自用。

| 决策        | 本轮选择与原因                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段边界    | 先实现可验证的 Fake Agent 闭环；真实订阅依赖用户登录，不以模拟结果替代                                                                   |
| 语言/运行时 | TypeScript 6.0.3 与当前 typed ESLint 兼容；Node.js 24.14+ 的 24.x、npm lockfile；Linux/WSL 优先                                          |
| SQLite      | node:sqlite、WAL、synchronous=FULL；独立 lease 数据库持有 OS 锁，阻止同一状态库被多个执行端同时打开                                      |
| 组件划分    | 核心实现位于 packages，应用只负责组合；导入边界由脚本检查；CLI 和 local-host 同进程，先不引入后台 daemon 与本机 UI IPC                   |
| MCP         | 固定 @modelcontextprotocol/sdk 1.32.1，用维护分支验证 stdio/tool 契约；正式维护前评估 v2 升级                                            |
| 运行时接口  | 只读 P0 probe 使用一轮一个 CLI 进程和明确 --resume UUID；长驻输入/中断留待实测                                                           |
| 远端隔离    | 专用 claude-relay 非 root 账号、独立目录；空内置工具清单、严格 MCP 配置、空 setting-sources、明确工具名称；不使用 --bare                 |
| 文件语义    | 128 KiB UTF-8，保留已有 BOM/CRLF；P1 拒绝全部 symlink，写入前再验证内容 hash；不宣称抵御任意外部进程的路径竞争                           |
| 命令语义    | 仅 exec/前台/非交互，最长 60 秒；不自动启动 shell，不支持 env 覆盖、PTY 或后台标志                                                       |
| 权限        | 默认 ask；read-only 禁止任何命令。accept-edits 仅作为执行端内部可测试策略，暂不在 CLI 暴露                                               |
| 恢复        | 先持久化再执行；同 ID 同参数重放结果；未知结果阻止副作用。新 ID 不能绕过该阻止                                                           |
| 事件        | 服务端持久化有限重放，客户端先持久化事件和游标再渲染；旧游标失效明确报错                                                                 |
| 发布        | 以 JackXing875/claude-tether 为主仓库；沿用用户添加的 GPL-3.0；private 防止误发布 npm；构建带源码的 tarball 并验收安装；不提交状态或凭据 |

不能把单账号、单活动 turn 和小型原型的测试结果推广为稳定生产服务。现有 VPS 约 1 GB 内存，低于官方 4 GB 要求；能安装和运行版本检查并不证明模型任务的内存可用性。

参考：[CLI 参数](https://code.claude.com/docs/en/cli-reference)、[程序化运行与 bare 模式](https://code.claude.com/docs/en/headless)、[系统要求](https://code.claude.com/docs/en/setup#system-requirements)、[Node 24.14 SQLite](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html)、[MCP 维护分支](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)。
