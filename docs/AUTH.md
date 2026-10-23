# 认证

两套身份完全独立。Anthropic 登录只交给 VPS 上的官方 Claude Code 管理；客户端持有的设备凭据只用于自己的 relay，不传给 Anthropic。

## 本次准备

VPS 已准备非 root 账号 claude-relay，其 HOME 为 /var/lib/claude-relay。官方 CLI 2.1.267 位于该账号的 .local/bin/claude。Node.js 独立安装在 /opt/personal-relay/runtime/node-v24.14.0-linux-x64，未替换系统 Node。

2026-10-23 已完成一次真实 Pro 登录与模型验收，见 [测试报告](LIVE-TEST-REPORT.md)。新部署仍须由账号所有者从自己的终端登录 VPS，在专用账号中执行：

```bash
su - claude-relay
DISABLE_AUTOUPDATER=1 /var/lib/claude-relay/.local/bin/claude auth login --claudeai
```

在官方页面登录自己的 Pro/Max。授权码只输入官方 CLI 的终端，不写入聊天、项目配置或 Git。官方账号维护流程见 [认证文档](https://code.claude.com/docs/en/authentication)。

## P0 检查

`tether doctor --json`（源码目录先构建后用 `node bin/tether.mjs doctor --json`）只运行依赖版本和认证状态检查，输出允许名单中的状态字段，不输出邮箱、token、原始响应或全量环境。它不证明订阅已成功调用。

workerEnvironment 在启动模型进程前拒绝已知 API Key、网关/第三方 provider 和长期 OAuth token 环境覆盖；只传递显式允许的环境变量。专用账号也必须排查 CLI 配置中的 apiKeyHelper 和 managed settings。程序不能仅靠环境检查宣布配置隔离完成。

候选参数使用 --tools 空值和 --strict-mcp-config，明确列出允许的桥接工具。禁止 --bare，因为它不读取订阅登录。[官方说明](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)

完成登录后，可在 VPS 上用 probe 命令检查只读 MCP、结构化输出与明确会话恢复：

```bash
PATH=/opt/personal-relay/runtime/node-v24.14.0-linux-x64/bin:$PATH \
DISABLE_AUTOUPDATER=1 \
node /opt/personal-relay/current/lib/node_modules/claude-tether/bin/tether.mjs probe \
  --cwd /var/lib/claude-relay/probe/session \
  --claude /var/lib/claude-relay/.local/bin/claude
```

上例要求先把当前包安装/更新到该位置；早期 VPS 副本不会自动更新，`current` 指向已安装的版本目录。使用已安装 CLI 时也可直接运行 `tether probe --cwd 私有目录 --claude 官方可执行文件`。该探针最多发出两轮真实请求，可能占用订阅额度；要求官方状态为 claude.ai，拒绝其他认证路径。它不是完整中转站验收，也未覆盖持续 stdin、多轮中断和完整配置隔离。

第一轮必须实际调用唯一的 `workspace_info` MCP 工具并返回本次随机生成的标记。第二轮必须沿用指定 UUID，在不调用工具的情况下回忆第一轮标记；新提示不会携带答案，工具中的标记也已更换。只返回成功状态、换成另一会话、重新调用工具或忘记标记都会失败，不能据此宣称恢复成功。标记可以跨多条文本事件到达；探针不把这一检查当作完整的流式延迟验收。

`--cwd` 是专用基础设施父目录，要求私有权限 0700；已存在的公开目录会被拒绝，不会被静默 chmod。每次运行在新建的临时子目录中保存挑战和 MCP 配置，成功、失败或 Ctrl-C/SIGTERM 后清理该子目录，并终止 CLI/MCP 进程组；父目录中的其他文件保留。官方 CLI 在 HOME 中管理的 transcript 不属于此临时目录清理范围。输出只包含布尔验收结果和脱敏错误，不输出随机标记或原始模型文本。

## 设备凭据

每设备使用 32 字节随机 secret，服务端仅保存 SHA-256 验证值，使用恒时比较。设备 ID 不是密码。凭据文件须 0600，状态目录须 0700；运行日志不输出凭据。

管理 CLI `tether device create/revoke` 要在服务停止时运行，因为数据库强制单进程所有权。运行中的库接口 revoke 会断开已有连接；面向用户的在线管理接口尚未实现。不要通过删除数据库实现吊销或“修复”未知操作。
