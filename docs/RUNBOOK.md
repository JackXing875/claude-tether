# 运行与恢复

## 安装与运行

先按 [快速开始](QUICKSTART.md) 安装或运行离线演示。开发验证使用 `npm run verify` 和 `npm run test:package`。服务和客户端当前仅支持 Linux/WSL。Node 版本由 .nvmrc 固定，ripgrep 必须存在于本地 PATH。

服务端设备注册会将 secret 写入指定的 0600 文件；不要将该文件放入项目或命令参数。`tether connect` 需要服务 URL 和设备文件；工作区默认当前目录，私有状态默认根据 URL/设备/项目/策略自动选择。工作区或策略发生变化时，使用新的绑定；不要复用另一个设备的状态目录。

P1 网络配置：

- 回环开发/SSH 隧道：服务只绑定 127.0.0.1，客户端显式 --allow-insecure-loopback。
- WSS：服务端传 --cert/--key。客户端验证系统 CA；私有 CA 可通过 --ca 显式信任，不提供关闭证书校验选项。
- 不配置公网无鉴权入口，不在 URL 中传 token。

## 停止和恢复

客户端 Ctrl+C 在当前 turn 中请求取消本地进程和远端任务；/quit 退出。服务端 SIGTERM/SIGINT 会停止接收、终止模拟 turn 并关闭状态库。命令终止不意味着已执行的副作用回滚。

断线后，不要重新发送整项任务。使用原客户端状态目录及 --resume 原 session ID。服务端首先查询本地操作结果；未知或缺失结果会阻止恢复。收到 FILE_CHANGED 后重新读取文件和预览；收到 UNKNOWN/RECONCILIATION_REQUIRED 时先人工核查操作效果。

忘记 session ID 时，用 `tether sessions` 并传入原 `--credential`、`--url`、`--workspace`，以及曾使用的 `--state` / `--read-only` 选项。列表只包含设备和完整项目身份匹配的会话，显示最近一轮状态、当前连接状态和待核实操作数；`--json` 只输出这些元数据。查询不会创建会话、推进 epoch、打开操作账本或解除 UNKNOWN 阻断，可以在客户端仍运行时查看。状态只是查询时的快照，选择 ID 后仍须显式 `connect --resume` 并通过对账。首次使用或缺少原身份文件时返回空列表，不自动重建身份；旧版 relay 不支持该 RPC，需要与客户端一起升级。

目前没有提供“一键清空 UNKNOWN”接口。不要删 journal 或换 operation_id 来绕过未知结果。如果确需归档，先停止两个组件，审阅已有文件/命令效果并保留数据库及 WAL 的一致备份，再明确建立新会话。

STATE_IN_USE 表示同一状态库已有活进程持有 SQLite lease。正常退出或进程崩溃后锁会释放；不要删除 lease 文件强行并行启动。

## VPS 已准备内容

deploy/bootstrap-vps.sh 仅准备 P0 依赖：独立 claude-relay 账号、/var/lib/claude-relay、官方 Claude Code 2.1.267，以及 /opt/personal-relay/runtime 下固定版本 Node。Node 归档校验 SHA-256，Claude 走官方安装器。脚本不配置防火墙、不注册 systemd、不开放公网端口。

原型程序副本位于 /opt/personal-relay/prototype，包含编译产物和生产依赖；源代码与构建保留在本地。该副本属于首轮原型，不会自动跟随 GitHub 更新。新版应按快速开始安装经过验收的 tarball，使用 `tether` 或 `node bin/tether.mjs`；升级前停止旧进程并备份状态。真实订阅稍后按 AUTH.md 登录。日常服务部署、TLS 域名、systemd 启动及资源测量仍待 P0 之后开展。

维护时保留 DISABLE_AUTOUPDATER=1；新版本先通过契约测试与真实 P0，再更新固定版本。当前网页文档可能描述比 2.1.267 更新的功能，本项目以实际安装版本帮助信息和测试为准。

## 诊断

`tether doctor --json` 输出脱敏的本地版本/认证方式，不发起模型请求。设备、操作和事件状态是私有数据；即使普通日志不存正文，SQLite 的结果和事件、官方 transcript 仍可能包含代码。

测试用的临时账号凭据和进程需要在联调后清理。保留安装好的专用运行环境，便于后续官方登录。不要停止 VPS 上不属于本项目的其他服务。
