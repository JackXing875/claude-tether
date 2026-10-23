# Claude Tether

[English](README.md) · [快速开始](docs/QUICKSTART.md) · [架构](docs/ARCHITECTURE.md) · [贡献指南](CONTRIBUTING.md)

让官方 Claude Code Agent 在自己的 VPS 上运行，把项目文件操作、命令和最终授权留在自己的电脑。

**当前为开发 alpha，尚不能作为日常 Claude 中转站。** 可运行的端到端链路使用离线 Fake Agent；候选官方 CLI supervisor、MCP 子进程桥和订阅探针已实现，并以替身 CLI 测试；真实官方账号行为尚未验证，公开 CLI 仍仅启用 fake runtime。具体退出条件见[路线图](docs/ROADMAP.md)。本项目与 Anthropic 无隶属关系。

## 两分钟体验

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

安装独立 `tether` 命令、双终端运行和 SSH 隧道见[快速开始](docs/QUICKSTART.md)。目前没有发布 npm 包，请勿把 `npx claude-tether` 当作此仓库的安装方式。

## 已实现的工程能力

- 设备独立凭据、WSS 或显式回环连接、吊销和会话绑定。
- 本地读取/搜索/编辑/创建、内容版本检查、diff 与单次批准。
- 参数数组启动的前台命令、超时、输出上限及进程组取消。
- SQLite 操作去重、崩溃后 UNKNOWN 阻断、显式恢复与事件持久化。
- 按原设备、项目与权限配置查询会话状态，并明确选择 ID 恢复。
- 独立核心模块、统一 CLI、类型声明、含源码的安装包。
- CI、静态检查、实际文件/进程/网络测试、仓库外安装验收。

代码主副本留在本地，但提示、请求读取的文件内容和工具结果会经过 VPS 与模型服务。命令经本地批准后，以本地用户权限执行；工作目录不是系统沙箱。

当前只支持单活动 turn、≤128 KiB UTF-8 普通文件、≤60 秒前台命令；后台任务、PTY、完整 TUI、自动重连、hooks/skills 和 IDE 集成尚未完成。[兼容性边界](docs/COMPATIBILITY.md)与[测试说明](docs/TESTING.md)分别记录能力和证据。

## 参与开发

```bash
# Ubuntu/WSL 测试依赖：sudo apt-get install ripgrep openssl
npm ci
npm run verify
npm run test:coverage
npm run test:package
```

CI 不需要任何 Claude 凭据。贡献规范见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞报告见 [SECURITY.md](SECURITY.md)。沿用仓库已有的 [GPL-3.0](LICENSE) 许可；`private: true` 仅防止误发布到 npm，不影响源码开放。项目不附带官方 Claude 二进制或账号凭据。
