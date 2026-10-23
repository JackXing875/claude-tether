# Claude Tether

[English](README.md) · [项目定位](docs/PRODUCT.md) · [路线图](docs/ROADMAP.md) · [原型快速开始](docs/QUICKSTART.md) · [贡献指南](CONTRIBUTING.md)

个人 Claude Code 自托管接入与运维工具：在本地使用官方客户端，通过自己的 VPS 连接官方模型服务。

**项目正在调整主线。** 目标为“本地官方 Claude Code → SSH 隧道 → VPS 上的 ccproxy → Anthropic”。ccproxy 负责请求转发；Tether 负责连接启动、独立配置、版本锁定、诊断和升级回退。Agent、原生工具、权限与会话交给本地官方客户端。账号持续可用性是首要设计目标，其次是原生体验；不承诺通过代理或请求伪装避免封号。详见[产品范围](docs/PRODUCT.md)和[源码调研](docs/NATIVE-CLAUDE-RESEARCH.md)。

| 路线                       | 当前状态                                                                     |
| -------------------------- | ---------------------------------------------------------------------------- |
| 本地官方 CLI + VPS ccproxy | 已选定方向；集成、部署和端到端验收待完成                                     |
| 远端 Agent + 本地工具桥    | 可运行的开发 alpha；官方 Claude Code 2.1.267 / Pro 已通过受控 VPS → WSL 验收 |

**下面的命令运行现有远端 Agent 原型。** `tether connect` 尚不能启动本地官方 Claude Code 或连接 ccproxy。原型已验证本地读搜改和测试、流式文本、服务重启后恢复、权限拒绝、文件冲突、取消和断线恢复，详见[真实测试报告与限制](docs/LIVE-TEST-REPORT.md)；长期稳定性未验收。本项目与 Anthropic、ccproxy 无隶属关系。

## 体验现有原型

需要 Linux 或 WSL2、Git、Node.js 24.14 及以上的 24.x、npm；文件搜索需要 `ripgrep`。推荐使用 [.nvmrc](.nvmrc) 固定版本。暂不支持 Windows 原生和 macOS。

```bash
git clone https://github.com/JackXing875/claude-tether.git
cd claude-tether
npm ci
npm run demo
```

演示会创建临时项目，读取一个错误的加法函数、展示 diff、修改文件，再运行真正的本地测试，最后清理目录。**无需 VPS、Claude 账号、API key 或付费**。自动批准只作用于演示自己创建的临时项目，最后应显示“演示验收通过”。Node 24 可能显示实验性 SQLite 提示。

```bash
node bin/tether.mjs --help
node bin/tether.mjs doctor
```

安装独立 `tether` 命令、双终端运行和 SSH 隧道见[原型快速开始](docs/QUICKSTART.md)。目前没有发布 npm 包，请勿把 `npx claude-tether` 当作此仓库的安装方式。

## 原型已实现的工程能力

- 设备独立凭据、WSS 或显式回环连接、吊销和会话绑定。
- 本地读取/搜索/编辑/创建、内容版本检查、diff 与单次批准。
- 参数数组启动的前台命令、超时、输出上限及进程组取消。
- SQLite 操作去重、崩溃后 UNKNOWN 阻断、显式恢复与事件持久化。
- 按原设备、项目与权限配置查询会话状态，并明确选择 ID 恢复。
- 独立核心模块、统一 CLI、类型声明、含源码的安装包。
- CI、静态检查、实际文件/进程/网络测试、仓库外安装验收。

代码主副本留在本地，但提示、请求读取的文件内容和工具结果会经过 VPS 与模型服务。命令经本地批准后，以本地用户权限执行；工作目录不是系统沙箱。

原型只支持单活动 turn、≤128 KiB UTF-8 普通文件、≤60 秒前台命令；后台任务、PTY、完整 TUI、自动重连、hooks/skills 和 IDE 集成尚未完成。[兼容性边界](docs/COMPATIBILITY.md)与[测试说明](docs/TESTING.md)分别记录能力和证据。复刻官方界面与工具生态不再是主线目标，新路线通过保留本地官方客户端来实现原生体验。

## 参与开发

```bash
# Ubuntu/WSL 测试依赖：sudo apt-get install ripgrep openssl
npm ci
npm run verify
npm run test:coverage
npm run test:package
```

CI 不需要任何 Claude 凭据。贡献规范见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞报告见 [SECURITY.md](SECURITY.md)。沿用仓库已有的 [GPL-3.0](LICENSE) 许可；`private: true` 仅防止误发布到 npm，不影响源码开放。项目不附带官方 Claude 二进制或账号凭据。
