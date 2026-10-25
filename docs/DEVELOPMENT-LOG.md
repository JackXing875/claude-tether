# 开发日志

最新进展：beta.6 已完成真实 Claude 验收、GitHub 发布和公开安装包验证；发布结果见阶段 3，功能结果及剩余范围见阶段 2 和[真实测试报告](PROCESS-MODE-LIVE-REPORT.md)。阶段 1 保留当时的计划与状态。

## 2026-10-25 阶段 1：可靠性修复、独立进程模式与发布前验收

当时状态：本地修改和自动化验收完成，真实 Claude 验收待做；尚未发布，也未更新原生 Linux 服务器的安装。基于 `0.3.0-beta.5`，包版本尚未提升。下列结果对应包含未提交修改的工作区，不能归入已发布的 beta.5。

### 已完成的修改

- P1/P2：异常上游 HTTP 响应仅影响当前请求；恢复流式 GET/DELETE 请求体边界；更新锁内重新读取版本、激活前再次检查；处理 TCP 半关闭；拒绝不支持的 HTTP Upgrade；让自定义 `TMPDIR` 下的私有 IPC 在隔离环境中可见。
- 进程模式：新增 `--processes host|isolated`，默认共享宿主 PID 视图，网络隔离保持开启。CLI 和 VS Code 共用设置；`setup` 保存设置，单次覆盖不修改配置。
- 生命周期：默认模式通过 Python 3.9+ 标准库实现 subreaper 和父进程死亡处理，清理本次启动的 detached/double-fork 工具。保留私有 PID 模式；不使用进程名匹配或同用户全局扫描来终止其他任务。
- 宿主诊断：新增 `tether doctor --inotify [--json]`，通过私有 IPC 返回当前用户的观察记录、内核限额及读取不完整信息。它不执行任意宿主命令；共享 PID 也不会解除 Linux 对 `fdinfo`、调试等操作的权限限制。
- 更新了使用说明、架构、安全边界和测试记录。P3 发布流程幂等性与并发改造继续暂缓。

### 验证记录

本条日志复核了本次实现留下的测试输出；记录日志本身未重跑测试，也未调用真实模型。

| 检查 | 结果 |
| --- | --- |
| `npm ci` / TypeScript 构建 / `npm test` | 75 项通过；失败、取消、跳过均为 0 |
| 两种进程模式 | 宿主 PID 可见性符合设置；直接 IPv4、IPv6、UDP、DNS 和宿主 loopback 仍被阻止 |
| 进程清理 | 正常退出、启动器 SIGTERM/SIGKILL、忽略 SIGTERM 的双重 fork 测试进程均得到清理；无关宿主进程保持运行 |
| inotify 诊断 | 能从隔离子进程观察宿主测试 watcher；严格 PID 模式明确拒绝；非法操作被拒绝；私有 IPC 正常清理 |
| VS Code 适配器 | 替身测试的双向 stdio、控制消息、参数、工作目录和退出行为通过；不是本次真实面板验收 |
| `npm run test:package` | 实际 tarball 安装、自更新、三个入口及包内 Python 辅助程序检查通过 |
| `npm audit --omit=dev` | 0 项已知漏洞 |
| 文档与版本检查 | 45 个本地文档链接有效；包与 lockfile 的版本、许可证一致；P3 workflow 未修改 |

详细覆盖范围见[测试报告](TEST-REPORT.md)。可提交的脱敏证据摘要见[本次证据](evidence/process-mode-local-2026-10-25.json)。原始日志保留在本机、被 Git 忽略的 `artifacts/process-mode-fixes/` 中：`tests.log`、`package-test.log`、`dependency-audit.json` 和 `summary.json`。报告不保存登录凭据、真实对话、请求正文或账号标识。

### 发布前需要补的真实验收

需要。此次改变的是官方 Claude 的默认进程环境与生命周期；替身测试不能证明官方 CLI、SDK 和插件在这些变化下全部兼容。[历史 CLI 验收](ISOLATED-LIVE-REPORT.md)和[历史 SDK/面板验收](VSCODE-LIVE-REPORT.md)针对旧版，只作为历史记录。

验收使用当前候选构建，记录其提交或源码指纹、安装包 SHA-256、官方 Claude/插件版本及测试结果。沿用现有官方登录和已选 VPS，在临时项目中串行完成少量普通任务；不先覆盖日常安装或重启已有会话。

| 项目 | 正常使用方式与通过条件 | 当前状态 |
| --- | --- | --- |
| 官方 CLI 与工具 | 一次简短编码任务，实际完成 Read、Edit/Write、Bash 和本地断言；检查真实工具事件、文件结果、权限交互及退出状态 | 待做 |
| 进程视图与宿主诊断 | 观察一个可辨认的临时宿主测试进程/watcher，运行 `ps` 和 `tether doctor --inotify`；验证记录来自宿主，未授予任意宿主执行能力 | 待做 |
| 会话和模型 | 正常退出后 resume，同一会话记住临时标记；验证模型切换与下一轮回复，记录实际模型结果 | 待做 |
| 交互与退出 | 测试正常取消、继续对话、正常退出；仅检查本次临时工具的清理，确认已有工作保持运行 | 待做 |
| 官方 VS Code 面板 | 在使用候选适配器的测试窗口中完成聊天、工具权限确认、文件修改、历史恢复和模型选择；SDK 自动化结果与人工面板观察分别记录 | 待做 |
| 原生 Linux 兼容性 | 部署日常入口前，以独立候选入口验证官方 CLI、宿主进程诊断和相同 Python 环境下的 GPU 设备/驱动可用性；不启动训练或占用现有 GPU 工作负载 | 待做 |

真实账号验收不包括主动断网、SSH 黑洞、休眠、强杀正在生成的模型流或批量重复请求。这些故障情形继续使用受控本地服务；尚未覆盖的长期行为保持明确标注。验收目标是确认功能兼容性，不能据此推导账号安全保证。

上述相关功能验收通过后，可以发布下一版 beta；如某个平台仍未测，必须单独标注，不能宣布全平台通过。是否成为正式版另行评估，这次记录不将长期运行、故障恢复或暂缓的 P3 自动视为已完成。

## 2026-10-25 阶段 2：真实模型验收与 beta.6 发布

用户授权真实模型验收，并在通过后发布。版本提升至 `0.3.0-beta.6`，用实际 tarball 安装的独立候选入口测试，沿用各自已登录的 Pro 和已选 VPS。没有覆盖日常安装、复制凭据或切换网络出口。

| 验收 | 结果 |
| --- | --- |
| WSL 真实工具 | 官方 Claude 2.1.310 / Sonnet 5.5 完成 Read、Edit、Write、Bash、MCP；修复临时加法实现，本地断言通过 |
| SDK 权限与模型控制 | 默认权限模式下逐项批准规定操作；PreToolUse 和控制通道通过；切换后实际收到 Opus 5.5 回复 |
| CLI resume | 正常结束 SDK 会话后，用新的候选 CLI 恢复同一会话；无需工具即准确回忆两个随机标记 |
| 宿主诊断与退出 | 真实 Bash 看见宿主测试进程和 watcher；临时 detached 心跳在会话内存活，正常输入 EOF 后停止 |
| 原生终端 | Ctrl+C 清除未发送输入后会话仍存活；`/model` 菜单正常打开、取消；`/exit` 状态 0 |
| 原生 Linux / GPU | 真实 Sonnet 执行获批 Bash 诊断；UVM 等设备可见，原有 PyTorch 2.7.1+cu126 能发现 CUDA；未初始化 PyTorch CUDA 上下文或分配张量 |
| 日常安装 | 原生 Linux 的日常版本在测试前后均为 beta.5，Tether 偏好哈希不变；候选仅在临时目录运行 |
| 自动化回归 | beta.6 版本下重新运行 75 项测试，全通过；生产依赖审计 0 项漏洞 |

两台机器测试了同一候选 tarball。将候选中的 23 个源码/运行时文件与待发布工作区逐字节比较，结果一致；最终报告只补充文档，发布前继续校验安装包和运行时指纹。[脱敏证据](evidence/process-mode-live-2026-10-25.json)保留候选哈希、运行时文件哈希及实际结果，原始日志在被 Git 忽略的 `artifacts/release-beta6/`。

记录两次测试脚本修正：原生 Linux 首次提示末尾的句号被模型当作 `.` 参数，精确权限规则正确拒绝，未执行诊断；修正命令分隔后通过，没有扩大权限或修改 Tether。终端首次停在新临时目录的信任提示，脚本明确选择信任自己创建的测试目录后通过。

完整宿主 inotify 扫描在两台机器均报告部分记录不可读，已如实保留 `incomplete` 标记；已验证的是已知 watcher 的可见性，不把它宣称为完整唯一 watch 总数。

发布范围：下一版 beta，包含已完成的 P1/P2 和进程模式改动，P3 继续暂缓。官方 VS Code 二进制及 SDK 通道已测，实际面板点击、历史选择器和渲染交互未重新测试。未做真实账号断网、网络黑洞、休眠或强杀生成中的会话。长时间运行、完整故障恢复及正式版资格仍需分别评估。发布资产与流水线状态以 [GitHub beta.6 Release](https://github.com/JackXing875/claude-tether/releases/tag/v0.3.0-beta.6) 为准。

## 2026-10-25 阶段 3：发布完成与公开资产验收

北京时间 **23:09:30**，GitHub 发布了 [v0.3.0-beta.6](https://github.com/JackXing875/claude-tether/releases/tag/v0.3.0-beta.6)。[PR #8](https://github.com/JackXing875/claude-tether/pull/8) 的分支及 PR 检查通过后合并；[发布流水线](https://github.com/JackXing875/claude-tether/actions/runs/40205535008)和[主分支 CI](https://github.com/JackXing875/claude-tether/actions/runs/40205534933)也均通过。标签对应提交 `01e3a83a4fb19807440a30f89526c17e61946257`，没有修改或复用旧版本标签。

从公开 Release 下载 tarball 与 `SHA256SUMS`，确认 SHA-256 为 `62d74c2af79e8981bd94d4d8867a6a2e4d6819d9a8a658f76b88c6f6b040eee7`，同时匹配 GitHub 资产 digest。23 个运行时文件与真实模型测试过的候选逐字节一致，发布说明和包内报告内容也一致。

在临时 npm prefix 中安装公开 tarball，版本与新增命令帮助正确，默认宿主进程模式的 Python/bubblewrap 检查通过，实际 GitHub `update --check` 成功。此次资产验证没有额外模型请求，也没有替换两台机器的日常安装。[发布验收凭据](evidence/beta6-publication-2026-10-25.json)记录上述结果；当前用户可通过 `tether update` 升级，再新开会话使用。
