# Personal Claude Relay

个人 Claude Code 远端运行时与本地工具桥。目标是：官方 Claude Code 和模型请求运行在自己的 VPS，项目文件、命令与最终权限判断留在客户端。

**当前是 P0/P1 开发原型，还不能作为日常 Claude 中转站使用。** 默认服务端是明确标注的 Fake Agent；官方 CLI 适配器和只读 MCP 探针已准备，真实订阅登录及联调尚未执行。用户已选择稍后登录。

## 本地体验

要求 Linux/WSL、Node.js 24.14.0、npm、ripgrep；完整测试另需 openssl。版本锁定于 .nvmrc 和 package-lock.json。Node 内置 SQLite 在该版本仍属实验功能，运行时会显示对应提示。

~~~bash
npm ci
npm test
npm run demo
~~~

demo 自动创建并清理临时项目：模拟 Agent 读取一个错误的加法函数，经演示专用批准修改，再运行真正的本地 Node 测试。它使用有鉴权的回环 WebSocket，不调用 Claude。演示的自动批准仅用于它自己创建的临时目录；普通客户端逐次询问。

## 当前能力

- 设备独立凭据、服务端哈希验证、设备吊销；WSS 或显式启用的回环 WS。
- 会话绑定设备、workspace、执行目标、策略版本及 worker epoch。
- 本地读取、按忽略规则列文件/搜索、带版本检查的编辑/创建，以及前台程序执行。
- 本地 diff 与单次批准、只读策略、审批超时默认拒绝。
- SQLite 操作去重、崩溃后 UNKNOWN 阻断、显式会话重连和结果对账、事件持久化与去重。
- Linux/WSL 前台进程组取消、输出截断、大小与队列限制。
- MCP SDK 工具注册/调用契约，以及官方 CLI 的受限启动参数、环境检查与 NDJSON 解码。

尚未完成：真实 Claude MCP → supervisor 的会话 IPC、订阅端到端运行、长驻 worker 控制、完整 TUI、后台任务/PTY、自动重连、完整恢复界面、编辑撤销、hooks/skills/IDE 和 Windows 原生。支持范围及测试证据见 [兼容性](docs/COMPATIBILITY.md) 与 [测试报告](docs/TEST-REPORT.md)。

## 分开运行服务端与客户端

先构建并创建私有状态目录。凭据写入文件，不打印到终端。

~~~bash
npm run build
RELAY_STATE_DIR="$HOME/.local/state/personal-claude-relay-dev"
mkdir -p "$RELAY_STATE_DIR"
chmod 700 "$RELAY_STATE_DIR"
npm run server -- --state "$RELAY_STATE_DIR/server/relay.sqlite" \
  --provision my-device --token-file "$RELAY_STATE_DIR/device.json"
npm run server -- --state "$RELAY_STATE_DIR/server/relay.sqlite" --port 8787
~~~

另一终端先复制 examples/minimal-workspace 到一个临时目录，再运行：

~~~bash
npm run bridge -- --config "$HOME/.local/state/personal-claude-relay-dev/device.json" \
  --state "$HOME/.local/state/personal-claude-relay-dev/client" \
  --workspace /absolute/path/to/copied-workspace \
  --url ws://127.0.0.1:8787/v1/bridge --allow-insecure-loopback
~~~

输入 demo 完成示例任务；read 相对路径读取文件；/quit 退出。客户端会打印 session ID；使用原状态目录加 --resume 该 ID 可以恢复连接。文件工具只支持工作区内的普通 UTF-8 文件，P1 拒绝符号链接。命令用程序和参数数组执行，任何程序都需要单次批准，cwd 不构成操作系统沙箱。

公网连接必须使用 WSS。服务端可配置 --cert 和 --key；也可以放在 TLS 反向代理后，仅监听回环。SSH 隧道的客户端端点可显式启用回环 WS。详情见 [运行手册](docs/RUNBOOK.md)。

## 实施路线与开源准备

原始背景和完整方案在 [START.md](START.md)，最新阶段记录在该文件第 30 节。实现取舍在 [DECISIONS.md](docs/DECISIONS.md)，认证边界在 [AUTH.md](docs/AUTH.md)，协议实现范围在 [PROTOCOL.md](docs/PROTOCOL.md)。

本轮新增代码为独立实现；没有复制复原版 Claude Code 或 New API 源码，没有打包官方 Claude 二进制/账户凭据。package.json 暂设 private 与 UNLICENSED，待原型验证和许可证选择后再公开发布。已提供 GitHub Actions 配置，尚未在 GitHub 上运行，也没有创建远程仓库。

代码主副本留在本地，但提供给 Agent 的文件内容、提示及工具结果会经过 VPS 和模型服务。操作结果、重放事件和官方会话也可能含项目内容，应作为私有状态保存。
