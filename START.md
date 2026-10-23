# 个人 Claude 中转站：远端 Agent 与本地工具桥接设计及交接文档

版本：1.2（开源工程化；原始设计与首轮证据保留）
编写日期：2026-10-22（Asia/Shanghai）  
用途：在一个全新的开发 session 中，仅依靠本文恢复需求、理解架构并开始实现。  
状态：官方 Pro 登录及 P0/P1 真实 VPS → WSL 验收已通过；公开真实 runtime、自动 SSH 连接和 systemd 模板已补齐。最新证据见第 36 节；第 30—35 节保留各阶段历史，不代表当前尚未登录。

> 给接手的开发 Agent：先阅读第 0、3、5、9、23、26 节。本文已记录用户最终选择，不要重新把项目默认改为 API Key 网关、本地 Claude Code 加代理，或 VPS 远程开发环境。实施中可以提出改进，但改变这些选择需要用户明确同意。

阅读导航：

| 想解决的问题 | 对应章节 |
| --- | --- |
| 用户到底选择了什么、与 New API 有何区别 | 0—3 |
| 要研究哪些项目、采用什么架构 | 4—7 |
| 如何实现接近原生的交互、订阅认证和远端进程控制 | 8—11 |
| 如何设计协议、本地工具、权限与项目上下文 | 12—15 |
| Windows/WSL 兼容、断线恢复和性能 | 16—19 |
| 如何部署、组织代码、分阶段实施及验收 | 20—25 |
| 新 session 如何立即开始、原始需求与资料来源 | 26—29 |

第 26.5 节附有可直接复制的新 session 启动提示。本文命令为待验证示例，不要把阅读交接文档等同于完成部署。

## 0. 已确认的决定与项目边界

### 0.1 用户最后确认的两项决定

认证方式问题：

> 这个个人中转站的上游，你打算使用哪种认证？

用户回答：

> Claude Pro／Max 订阅登录

架构取舍问题：

> 在保留 Pro／Max 订阅的情况下，是优先原生本地体验、让 Claude Code 留在本地只经 VPS 转发，还是主进程必须在 VPS？

用户回答：

> 主进程必须在 VPS：本地使用兼容客户端和工具桥接，接受更大的开发量

因此，本项目默认实施路线已经确定：

**用户自己的官方 Claude Code 运行在东京 VPS，使用用户自己的 Pro／Max 订阅登录。Windows、WSL 或另一台服务器运行兼容客户端与本地工具执行服务。项目文件、项目命令和执行权限留在客户端所在的环境。**

“本地”是相对于客户端而言，不一定是用户的物理笔记本。例如用户在另一台 Linux 服务器启动客户端，那台服务器就是工具执行端。

### 0.2 五条不能擅自改变的约束

| ID | 已确认约束 | 对实现的影响 |
| --- | --- | --- |
| H1 | Claude Code 主进程及模型连接在东京 VPS | 不能把本地官方 CLI 配置代理当作项目完成 |
| H2 | 用户项目的文件和命令在本地执行 | 不能把项目 clone 到 VPS 后声称等价 |
| H3 | 使用用户自己的 Pro／Max 订阅 | 不能默认切换 API Key、云厂商计费或第三方渠道 |
| H4 | 日常体验尽量接近本地 Claude Code | 需要本地 TUI、diff、权限确认、文件引用、任务控制 |
| H5 | 个人使用，多个自有设备可接入 | 不建设商业分发、多人共享订阅、账号池或额度转售系统 |

### 0.3 “中转站”的准确含义

产品上它是用户无须关心的中转站；工程上它是一个**有状态的远端 Agent 服务**。

VPS 负责的是：

- 托管官方 Claude Code 进程。
- 保持对话和上下文。
- 向 Anthropic 发起模型请求。
- 将模型需要的项目操作派发到本地。
- 接收本地执行结果并继续 Agent 循环。

它不只是转发一个 HTTP 请求，也不只是把标准输入和输出接到浏览器。

### 0.4 已完成与未完成

已完成：需求澄清、仓库关系识别、New API 关键路径阅读、官方 CLI/MCP/认证文档核对、架构设计。

原始交接时未完成：代码仓库初始化、VPS 登录或部署、运行官方 CLI 验证、订阅登录验证、端到端工具桥接、Windows 兼容性测试、性能测量和安全审计。本轮实施后已完成项见第 30 节；本节其余内容保留原设计的证据边界。

本文中的命令、协议、数据结构、目录和参数默认值均为设计或待验证示例。标记“已核对”的是接口存在性或阅读到的实现，不代表整条链路已跑通。

## 1. 动机与用户希望解决的问题

用户已有一台位于东京的 VPS，希望将 Claude 的模型访问集中在这台机器上，并在多个自有设备上保留本地开发体验。

最初动机包含对 Claude 账号稳定性及网络出口变化的担忧。用户提到“Claude 很容易封号”，这是用户提出问题的背景；本次研究没有建立封号概率、原因分布或特定出口能够降低风险的统计证据。

可明确交付的工程目标是：

1. 模型连接由固定的远端运行环境发起。
2. 日常使用不需要手工 SSH、复制命令或同步项目。
3. 本地代码、依赖、Git、开发服务器和工具凭据继续在原环境使用。
4. 多台自有机器通过同一套客户端接入。
5. 断线后能够恢复，并避免重复执行有副作用的操作。
6. 通过版本锁定和契约测试维护兼容性。

不能承诺的目标是：

- 永不封号、绕过服务端限制或保证某地区/某账号一定可用。
- 所有请求内容只包含 VPS 信息。
- 与官方本地交互式 CLI 的每个功能、插件、快捷键完全一致。
- 本地终端关闭或网络中断时任何任务都能无损继续。
- 在任意崩溃条件下让任意 Shell 命令严格“恰好执行一次”。

本项目采用正常的加密通信，不以伪造客户端身份、删除认证机制、轮换账号或规避服务端限制为实现手段。

## 2. 需求清单与验收口径

### 2.1 功能要求

| ID | 要求 | 验收口径 |
| --- | --- | --- |
| F01 | 本地启动 | 在项目目录执行客户端，工作目录被正确识别 |
| F02 | 远端 Agent | 本地无主 Agent 循环，VPS 有真实官方 Claude Code worker |
| F03 | 本地读文件 | 读取结果来自本地真实文件，而非远端副本 |
| F04 | 本地搜索 | 文件匹配、内容搜索使用本地仓库与忽略规则 |
| F05 | 本地编辑 | diff、版本检查和实际写入在本地发生 |
| F06 | 本地执行 | 命令使用本地 Shell、PATH、虚拟环境和当前目录 |
| F07 | 权限确认 | 需要确认的动作在当前客户端展示，拒绝后无副作用 |
| F08 | 流式输出 | 回答和命令进度无需等整个任务结束才出现 |
| F09 | 本地开发服务 | 开发服务监听本地环境，用户能按本地方式访问 |
| F10 | 中断 | Ctrl+C 可取消远端当前 turn，并控制本地任务 |
| F11 | 会话恢复 | 明确关联原会话和原项目，不自动续接“最近一个未知会话” |
| F12 | 网络恢复 | 重连先对账，已有操作不因简单重发而重复执行 |
| F13 | 项目配置 | 逐步支持本地 CLAUDE.md、hooks、skills 和必要配置 |
| F14 | 多环境 | WSL、Linux、Windows 使用各自真实的环境语义 |
| F15 | 个人多设备 | 每个设备和项目具有独立绑定，不串会话 |
| F16 | 订阅认证 | 实际使用个人订阅，不能被环境中残留 API Key 抢占 |

### 2.2 第一版范围

第一版完成文字对话、读/搜/改文件、非交互命令、权限确认、取消、会话恢复及必要的故障处理。

“第一版可用”不要求已经实现官方 CLI 的所有斜杠命令、所有插件、完整 MCP 生态、自动权限分类器、IDE 插件、浏览器控制、语音、完整 worktree/subagent 工作流。

未支持的功能必须明确标记，不得静默在 VPS 执行，也不得显示虚假的成功。

### 2.3 体验要求

用户正常界面中看到的是自己的项目、路径、命令与修改。VPS hostname、内部端口、远端临时目录、连接 token 不进入正常对话展示。

实际连接失败、需要重新登录或运行受限时，应如实显示“连接恢复中”“需要重新登录”“操作状态待核实”等可操作信息。无感不等于隐藏错误或把远端运行谎称为本地运行。

## 3. 与 New API 的关系，以及为什么不能直接套用

### 3.1 三种不同的系统

| 类型 | Agent 循环在哪里 | 工具在哪里 | VPS 做什么 | 是否满足已确认需求 |
| --- | --- | --- | --- | --- |
| 网络代理/隧道 | 本地 | 本地 | 转发网络连接 | 否：主进程不在 VPS |
| New API 类模型网关 | 通常由客户端持有 | 通常在客户端 | 鉴权、选渠道、转发/转换模型协议 | 否：网关自身不等于 Claude Code 主进程 |
| 本文的 Agent 中转服务 | VPS 的官方 Claude Code | 本地执行服务 | 托管会话并双向调度工具 | 是：本项目选定路线 |

New API 与本项目相同的部分是“客户端连接一个自有服务，由这个服务连接上游”。不同的是转发的抽象层。

New API 接收的是模型 API 请求，例如 Anthropic Messages。本文客户端发送的是用户对话和会话操作；远端 Agent 在处理中可以调用很多次模型和很多次本地工具。

### 3.2 New API 仓库核对结果

研究入口：[QuantumNous/new-api](https://github.com/QuantumNous/new-api)。

核对版本：

- commit：e9d4d6353ce2c11df753d751ba1ad778e2433a88。
- 该提交时间：2026-10-22T14:41:17Z。
- 阅读快照以该 commit 为准，不把 main 分支将来的行为视作已验证。

实际阅读的关键路径及后续定位入口：

| 路径 | 观察到的职责/行为 | 对本项目的启发 |
| --- | --- | --- |
| router/relay-router.go | 注册模型中转路由，包括 /v1/messages | 对外接口需要版本化并清晰分层 |
| middleware/auth.go、middleware/distributor.go | 仅通过目录定位，未展开阅读；供后续研究鉴权及渠道分配 | 设备鉴权和会话路由应独立于模型凭据 |
| controller/relay.go | 中转控制、错误与重试逻辑 | 流已开始后的错误和重试不能随意处理 |
| relay/claude_handler.go | Claude 请求处理，包含 body passthrough 与转换分支 | 透传与转换是不同模式，不能混为一谈 |
| relay/channel/claude/adaptor.go | 构造上游地址与请求头，常规 Claude 适配器使用配置的 x-api-key | 不能假设填写订阅登录就等同 API Key 渠道 |
| relaykit/README.md | 模型协议转换模块及转换损失说明 | 本项目第一版不需要跨模型协议转换 |
| LICENSE | AGPL-3.0 | 参考架构不等于可以无条件复制代码 |

两个容易忽略的具体事实：

1. 该快照中 /messages/count_tokens 路由被注释，不能仅因有 /messages 就声称全部 Claude Code 网关能力完整；官方当前文档将计数端点视为可选，缺失时存在估算回退，因此也不能据此声称 Claude Code 完全无法使用。
2. 请求体 passthrough 不等于凭据、请求头、流式响应和会话语义全部透明。需要逐项核对。

相关固定版本链接：

- [路由](https://github.com/QuantumNous/new-api/blob/e9d4d6353ce2c11df753d751ba1ad778e2433a88/router/relay-router.go)
- [Claude 适配器](https://github.com/QuantumNous/new-api/blob/e9d4d6353ce2c11df753d751ba1ad778e2433a88/relay/channel/claude/adaptor.go)
- [Claude 请求处理](https://github.com/QuantumNous/new-api/blob/e9d4d6353ce2c11df753d751ba1ad778e2433a88/relay/claude_handler.go)
- [RelayKit](https://github.com/QuantumNous/new-api/blob/e9d4d6353ce2c11df753d751ba1ad778e2433a88/relaykit/README.md)

### 3.3 关于“订阅不能经网关”的必要澄清

不能简单断言所有模型网关都只能使用 API Key。

核对时的官方文档明确描述：只配置 ANTHROPIC_BASE_URL、未设置替代网关凭据时，已保存的订阅登录可以仍是活动凭据；这与配置 ANTHROPIC_AUTH_TOKEN 或 API Key 后改变凭据来源的情况不同。网关需要保留相关 OAuth capability 请求头。这是文档描述的连接行为，不是对任意第三方产品使用方式的授权结论。

因此，本项目不采用 New API 的根本原因是**用户已选择远端主进程与本地工具的架构**，不是“订阅从技术上绝不可能经过任何网关”。

New API 当前常规 Claude 渠道路径、个人透明网关、官方 CLI 的订阅认证、面向他人的第三方产品，四者必须区分。本文不建设收集或分发订阅 token 的模型服务。

依据：[官方网关与订阅说明](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways)、[网关兼容性参考](https://code.claude.com/docs/en/llm-gateway-protocol)。

### 3.4 不做“把 claude -p 包成 /v1/messages”这一捷径

一次 claude -p 调用已经可能包含多轮模型请求、工具调用、上下文管理和副作用。

如果把它的最终文字响应伪装成一次底层模型响应，让另一份本地 Claude Code 再驱动工具循环，会产生：

- 内外两套 Agent 循环和权限系统。
- 无法可靠对应的 tool_use / tool_result。
- 会话与状态混淆。
- 流式事件、计量和停止原因不匹配。
- 重试可能重做整项任务。

本文对外暴露的是 bridge session 协议，而非声称兼容 Anthropic 的模型端点。普通本地官方 Claude Code 不能仅修改 base URL 就成为本文系统的前端。

## 4. 相关项目、资料与阅读顺序

### 4.1 官方 Claude Code：生产运行时优先

优先使用官方发布、未经修改的 Claude Code 二进制，在 VPS 上通过个人订阅登录运行。

应阅读：

- [程序化运行](https://code.claude.com/docs/en/headless)
- [CLI 参数](https://code.claude.com/docs/en/cli-reference)
- [认证](https://code.claude.com/docs/en/authentication)
- [MCP 接入](https://code.claude.com/docs/en/mcp)
- [权限机制](https://code.claude.com/docs/en/agent-sdk/permissions)
- [用户输入与审批](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Agent SDK 总览](https://code.claude.com/docs/en/agent-sdk/overview)

官方 Agent SDK 是备选的进程控制接口，不要把“能用 SDK”与“所有认证场景都可直接套用”混为一谈。本项目先验证官方 CLI 在个人订阅下的程序化运行，再决定是否需要 SDK 适配器。

### 4.2 用户提供的复原源码仓库：理解行为、定位耦合

仓库：[JackXing875/claude-code](https://github.com/JackXing875/claude-code)。

快照：c57e6ee38437e33dc8f6eb773e2c3d572c188778，提交时间 2026-04-01T09:18:48Z。

其 README 将项目描述为反编译/逆向还原项目。它不是 Anthropic 官方发布的完整可修改源码。不能仅因能浏览、能运行就默认具备复制、分发或改作产品的授权。

建议按下表阅读：

| 路径 | 阅读目的 |
| --- | --- |
| src/cli/structuredIO.ts | 理解 NDJSON、控制消息、权限响应 |
| src/cli/print.ts | 理解程序化入口、初始化、中断、流式输出 |
| src/cli/remoteIO.ts | 理解远端传输与会话事件 |
| src/Tool.ts | 看清工具描述、校验、执行、权限、展示之间的耦合 |
| src/services/tools/toolExecution.ts | 确认 validateInput 发生在 call 之前 |
| src/tools/FileEditTool/FileEditTool.ts | 理解文件过期检查、修改历史和诊断 |
| src/context.ts | 理解工具调用之外的 Git/项目上下文采集 |
| src/constants/prompts.ts | 理解运行环境信息进入模型上下文的路径 |
| src/screens/REPL.tsx | 参考终端交互组织方式 |
| src/services/api/client.ts | 了解客户端请求头与认证接入点，不据此仿造认证 |

特别注意：该快照部分 SDK control types 是宽泛类型或 stub。它们只能作为研究线索，不能当作官方稳定协议规范。

### 4.3 上游复原项目：参考远端服务

上游：[claude-code-best/claude-code](https://github.com/claude-code-best/claude-code)。

快照：77a7934e15d69da13879112ed7db695c9ee7a52a，提交时间 2026-08-24T00:33:27Z。

相关路径：

- packages/remote-control-server/
- docs/features/remote-control-self-hosting.md
- src/bridge/
- packages/acp-link/

已经看到上游提供 RCS、自托管界面、消息传输和权限交互。其文档及入口代码说明 RCS 状态在内存中，不应假定挂载一个 data volume 就已经获得持久化恢复。

RCS 主要解决远端操控一个 Agent，不自动解决本文要求的“项目工具全部执行在客户端”。

### 4.4 阅读顺序

1. 官方认证与程序化运行文档，验证个人订阅可运行的真实路径。
2. 官方 MCP 与 CLI 文档，验证工具桥接接入点。
3. 本文协议、状态机及验收标准。
4. 用户仓库中的 Tool、toolExecution、FileEditTool、context。
5. 上游 RCS，学习连接与权限事件组织。
6. New API，学习服务边界、路由、流式错误处理。

不要先花大量时间部署 New API 管理后台，再回头发现它不是所需架构。

## 5. 架构决策记录

| ADR | 决策 | 原因 | 允许重新评估的条件 |
| --- | --- | --- | --- |
| ADR-01 | 远端主进程＋本地工具 | 用户明确确认 | 用户主动改变目标 |
| ADR-02 | 官方二进制作为主运行时 | 保留官方认证及升级路径，降低复原源码维护负担 | 官方公开接口无法满足关键功能，并完成替代方案评估 |
| ADR-03 | MVP 使用 CLI subprocess adapter | 先验证个人订阅与原生程序化接口，不预设 API Key | 官方 SDK 控制能力更可靠且认证适用性已确认 |
| ADR-04 | MCP 作为 Claude 到工具桥的接口 | 有公开文档，能定义本地能力 | 确有无法表达的必需能力 |
| ADR-05 | 自定义 WSS 协议连接两端 | 本地主动连接、穿过 NAT、支持双向消息与事件恢复 | 实测表明其他传输更适合 |
| ADR-06 | 本地执行端拥有最终权限 | 只有它掌握真实文件、环境和用户同意 | 不作为普通实现选择变更 |
| ADR-07 | 项目不复制到 VPS 执行 | 保持本地工具与文件语义 | 用户明确增加远端执行模式 |
| ADR-08 | SQLite 元数据＋官方会话记录 | 个人单节点部署，先减少运维组件 | 有测量证明需要其他存储 |
| ADR-09 | 业务协议不伪装模型 API | Agent 会话与单次推理语义不同 | 另立项目定义真正的模型网关 |
| ADR-10 | 本地兼容客户端，不承诺完整原版 TUI | 主进程远端与原版单进程交互存在结构差异 | 增量实现并用兼容性测试证明 |
| ADR-11 | 不自动重放整项 Agent 任务 | 工具可能已经产生副作用 | 仅可重放经分类确认安全的通信操作 |
| ADR-12 | 第一版单账号、单活动 turn | 控制并发和订阅使用复杂度 | 单会话可靠后，再开放少量独立会话 |

## 6. 系统组成及部署关系

### 6.1 逻辑架构

~~~mermaid
flowchart LR
    subgraph LOCAL["Windows / WSL / Linux 客户端环境"]
        UI["bridge-cli：本地 TUI"]
        LH["local-host：执行与权限"]
        DATA["本地项目、Shell、Git、任务日志"]
        UI <-->|本机 IPC| LH
        LH <--> DATA
    end
    subgraph VPS["东京 VPS"]
        RS["relay-server：连接与事件"]
        SS["session-supervisor：进程与恢复"]
        MC["mcp-bridge：工具适配"]
        CC["官方 Claude Code worker"]
        RS <--> SS
        SS <-->|NDJSON stdin/stdout| CC
        CC <-->|MCP stdio| MC
        MC <--> RS
    end
    LH <-->|WSS 主动连接| RS
    CC <-->|官方认证的 HTTPS| A["Anthropic"]
~~~

### 6.2 组件职责

| 组件 | 所在位置 | 职责 | 不应承担 |
| --- | --- | --- | --- |
| bridge-cli | 本地 | 输入、渲染、diff、快捷键、文件补全、批准操作 | 模型请求、读取 Anthropic token |
| local-host | 本地 | workspace、权限、文件、进程、hooks、操作日志 | 自行向 Anthropic 发请求 |
| relay-server | VPS | 设备鉴权、连接、多路会话、事件转发和补发 | 修改工具参数、暗中批准本地操作 |
| session-supervisor | VPS | worker 生命周期、会话绑定、队列、恢复 | 重新实现官方 OAuth 或模型 API |
| claude-runtime-adapter | VPS | 将稳定业务动作映射为 CLI/SDK 操作 | 将供应商内部事件结构泄漏为公共协议 |
| mcp-bridge | VPS | 注册工具、关联操作 ID、通过桥传递调用 | 在 VPS 上代替客户端执行项目工具 |
| 官方 Claude Code | VPS | 模型与 Agent 循环、官方认证、原生会话记录 | 通过内置项目工具误操作 VPS |

前期 relay-server 与 session-supervisor 可以在一个程序内实现，保持模块分离即可。不要为了形式拆成多套微服务。

mcp-bridge 作为官方 CLI 启动的 stdio 子进程，可以通过受权限保护的本机 IPC 连接 supervisor。IPC 路径或短期绑定参数需要绑定 worker/session，不能允许任意进程串接别人的会话。

### 6.3 “全本地执行”的精确定义

本项目要求用户项目的读取、编辑、搜索、Shell、Git、构建、测试、开发服务在客户端环境执行。

VPS 上仍然会有必要的系统进程和文件，例如官方 Claude Code、MCP 适配器、服务日志、会话记录、临时上下文文件。不能把这些基础设施操作与用户项目工具混为一谈。

模型服务侧内置的托管能力，以及官方运行时自身的后台行为，需要单独盘点。第一版只向模型开放审核过的本地工具集合，不承诺所有未来官方功能自动符合该边界。

## 7. 状态归属、数据流与可见信息

### 7.1 权威状态表

| 状态 | 权威位置 | 远端可持有什么 |
| --- | --- | --- |
| 文件当前内容 | 本地文件系统 | 模型已读内容的缓存及版本 |
| 工作目录、Shell、环境 | 本地会话 | 必要的环境描述 |
| Git 与 worktree | 本地仓库 | 当次状态快照 |
| 用户审批与策略 | 本地执行服务 | 状态摘要、结果，不是越权凭证 |
| 编辑历史与撤销 | 本地存储 | 操作 ID、diff 摘要 |
| 命令进程与输出 | 本地任务管理器 | 任务状态、选定输出 |
| Agent 对话 | VPS 官方 worker/session | 本地显示副本 |
| 消息投递记录 | 两端各自持久化 | 已确认游标 |
| Anthropic 登录 | VPS 官方 CLI 管理 | bridge 协议不传 token |
| bridge 设备凭据 | 本地设备与 VPS 服务 | 仅用于自有服务鉴权 |

### 7.2 网络信息与内容信息不能混为一谈

在本方案中，模型连接由 VPS 发起；若 VPS 出站又经其他代理，最终看到的出口会是那层代理。

但本地操作系统、Shell、项目路径、代码和工具输出可能进入模型上下文。模型需要知道执行目标是 Windows 还是 Linux 才能正确使用工具。

推荐在上下文中清楚区分：

~~~text
Agent runtime: remote Linux service
Tool execution target: user's Windows workspace
Project operations: use only the registered local_bridge tools
Path semantics: interpreted by the local execution host
~~~

不要伪造“只有一个 Linux 环境”来隐藏事实，这会损害命令正确性。

### 7.3 本地客户端并非完全没有外部网络

本地 npm、Git、测试程序或用户配置的 MCP 服务可能访问网络。这属于本地工具行为，不等同于本地发起 Claude 模型请求。

登录时若用户在本地浏览器打开 Anthropic 官方授权页面，浏览器仍会产生独立连接。本方案不承诺登录、账户管理、浏览器访问也全部看起来只来自 VPS。

### 7.4 数据不是“从不离开本地”

代码主副本留在本地，但模型需要的代码片段、用户提示和工具结果会经 VPS 发送给模型服务。VPS 的官方会话记录也可能保存这些内容。

不得在文案中声称“代码不会上传”或“VPS 完全不接触内容”。日志默认最小化，并单独配置官方会话记录的保留和删除方式。

## 8. 本地交互与命令设计

### 8.1 设计中的客户端命令

以下名称是本项目自定义 CLI，不是现有 Claude Code 参数。

~~~text
bridge
bridge connect
bridge status
bridge sessions
bridge resume <session-id>
bridge tasks
bridge stop <task-id>
bridge doctor
bridge auth status
bridge config
~~~

建议首次安装时完成服务地址和设备绑定。正常使用只需进入项目后运行 bridge。

不要在未说明的情况下覆盖用户现有 claude 可执行文件。需要短命令时可由用户显式添加 alias。

### 8.2 TUI 必需行为

- 输入和编辑多行提示；流式展示回答。
- 展示工具名称、参数摘要、执行状态。
- 文件修改展示本地 diff，保持可读的本地路径。
- 权限确认绑定当前操作，支持单次允许/拒绝；更大范围授权必须明确区分。
- 文件引用与路径补全从本地索引得到。
- Ctrl+C 首次取消当前操作，退出行为单独处理，避免误杀整个后台服务。
- 接收重放事件时不重复显示同一段文字。
- 断线显示状态，恢复后继续同一会话。
- 工具错误与连接错误区分展示。

终端 ANSI 控制字符需要按输出类型处理，命令日志不能随意注入 UI 控制序列。

### 8.3 斜杠命令路由

| 命令类别 | 处理位置 | MVP 策略 |
| --- | --- | --- |
| 清屏、帮助、主题 | 本地 UI | 自行实现明确的兼容子集 |
| 项目目录与权限 | local-host | 本地处理并同步必要状态 |
| 对话恢复、模型选择 | supervisor/runtime adapter | 仅暴露经版本测试的功能 |
| 登录 | VPS 官方 CLI 管理流程 | 不把 token 当聊天消息提交 |
| skills/custom commands | 本地解析＋远端提示 | 分阶段支持，避免误在 VPS 执行脚本 |
| 未支持命令 | 本地 UI | 明确报告，不直接透传猜测 |

不能把所有以 / 开头的输入原样交给 claude -p 并假定与交互式 REPL 相同。

## 9. 订阅认证及运行环境

### 9.1 首选认证路径

1. 为个人服务准备专用的非 root 运行账号。
2. 在 VPS 上安装官方发布的 Claude Code。
3. 通过官方交互式登录流程登录用户自己的 Pro／Max。
4. 保留官方 CLI 管理的凭据存储和刷新流程。
5. supervisor 在该授权环境下启动 worker。
6. bridge 客户端只持有 bridge 自己的设备凭据，不持有 Anthropic token。

自动化程序不要解析、导出或复制官方凭据文件来重新实现 Anthropic HTTP 客户端。

### 9.2 必须检查的环境污染

启动 worker 前，核对是否意外设置了 ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN、apiKeyHelper 或云厂商 provider 配置。它们可能改变实际认证来源。

检查应输出“是否存在/使用哪种方式”的脱敏信息，不输出凭据值。不要清空整个用户环境；应为 worker 显式构建必要环境。

当前官方认证文档还提供 setup-token 的脚本认证路径，但本项目默认优先使用官方登录存储，不把长期 token 放进配置样例、命令历史或聊天。相关机制需要时再按部署版本确认。[认证参考](https://code.claude.com/docs/en/authentication)

### 9.3 不要使用 --bare 破坏订阅认证

核对时的官方文档说明 bare 模式不读取订阅 OAuth。不能为了减少自动加载而给本项目默认加 --bare，然后在失败后偷偷切换 API Key。

应通过专用运行账号、干净工作目录、明确配置与 MCP 限制减少自动加载，并在 P0 验证实际行为。未来 CLI 默认值可能变化，所以必须锁定运行时版本并进行升级验证。[程序化运行说明](https://code.claude.com/docs/en/headless)

### 9.4 适用性边界

本项目是用户自己使用官方 CLI 的个人远程执行环境，不应扩展成收集他人 Claude 登录、分发订阅凭据或销售订阅额度的服务。

官方文档对个人官方客户端认证、SDK 产品和第三方服务有不同说明。本文记录技术路径，不对未验证的新业务场景做授权保证。若范围扩展为他人使用，应重新核对适用的官方说明。[官方认证使用说明](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)

### 9.5 认证故障行为

- 过期或需重新登录：停止派发新模型任务，显示需要在服务端完成官方登录。
- 用量限制：显示官方返回的信息，等待或由用户处理，不自动换账号。
- 认证失败：保留脱敏错误与运行时版本，不连续高速重试。
- 登录中：其他会话不应试图覆盖凭据。
- 订阅类型变化：重新做最小 smoke test。

## 10. 官方运行时适配器与 P0 命令示意

### 10.1 适配层接口

~~~typescript
interface AgentRuntime {
  start(config: RuntimeConfig): Promise<RuntimeHandle>;
  submit(handle: RuntimeHandle, input: UserTurn): Promise<void>;
  events(handle: RuntimeHandle): AsyncIterable<AgentEvent>;
  interrupt(handle: RuntimeHandle): Promise<InterruptReceipt>;
  resume(config: ResumeConfig): Promise<RuntimeHandle>;
  stop(handle: RuntimeHandle): Promise<void>;
}
~~~

这是本项目接口，不是官方 SDK API。实现中不要把官方内部消息直接当作长期公共协议；通过适配器转换，保留必要的原始事件供诊断。

### 10.2 候选启动命令

下面是需要在 P0 验证的组合，不是已经测试通过的安装脚本：

~~~bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --tools "" \
  --strict-mcp-config \
  --mcp-config /var/lib/personal-relay/generated/session-mcp.json \
  --append-system-prompt-file /var/lib/personal-relay/generated/session-context.txt \
  --allowedTools "mcp__local_bridge__*"
~~~

含义：用结构化流驱动官方进程，移除可误操作 VPS 的内置项目工具，仅加载指定桥接服务器。allowedTools 在这里批准的是进入我们自己的桥接工具处理函数，最终本地动作仍必须经过 local-host 的权限检查。

示例通配符仅用于 P0 演示。生产配置应根据协商后的工具清单生成明确名称，新增工具必须重新检查能力与本地权限；不要因为名称使用同一前缀就自动授予它执行权限。

这些参数单独的含义已核对；组合、MCP 名称、版本差异及订阅下行为必须实测。少量官方控制工具可能仍存在，应以初始化事件和实测列出的工具为准，不把空 tools 理解为官方进程绝无任何内部活动。[CLI 参考](https://code.claude.com/docs/en/cli-reference)

### 10.3 MCP 配置示意

~~~json
{
  "mcpServers": {
    "local_bridge": {
      "type": "stdio",
      "command": "/opt/personal-relay/bin/mcp-bridge",
      "args": [
        "--session",
        "SESSION_ID",
        "--ipc",
        "/run/personal-relay/session.sock"
      ]
    }
  }
}
~~~

路径和 SESSION_ID 是示意。生产实现用参数数组启动进程，不把用户提示或 JSON 拼接进 Shell 命令。

stdio 的 stdout 只用于 MCP，诊断写 stderr。适配器不得把远端临时工作目录当作用户项目根目录；MCP 进程从官方 CLI 继承的项目路径指向 VPS 基础设施目录，不是本地 workspace。

### 10.4 程序化会话策略

优先保持一个活跃会话对应一个 worker，stdin 持续开放，按版本验证多轮输入。

若目标版本的持续输入、取消或恢复行为不足够稳定，可采用“一轮一个 -p 进程＋明确 --resume 会话 ID”的受控回退。这个回退仍在 VPS 运行，不改变架构，但每轮开始前必须对账本地未完成操作。

不要使用 --continue 去猜“最近一次会话”。不要默认关闭会话持久化。

### 10.5 官方事件的隔离

初期至少处理：初始化、助手消息、文本增量、工具调用相关信息、结果、错误、限流/认证提示。

未知事件应保存类型并安全忽略或降级展示；缺少关键终止事件不能伪装成功。新增事件的兼容性由固定版本 fixture 测试覆盖。

中断先使用公开且已测试的进程/SDK控制能力。复原源码中的控制消息可辅助理解，但不能仅凭它们存在就当作官方稳定接口。

## 11. 会话生命周期与调用链

### 11.1 启动流程

1. 用户在项目目录启动 bridge-cli。
2. 客户端检查或启动 local-host。
3. 客户端把启动目录、所选执行目标及当前环境快照交给 local-host；完整环境只在本机传递。
4. local-host 解析真实 workspace，处理首次项目信任，生成必要的描述。
5. local-host 主动连接 relay-server，完成设备认证和协议协商。
6. 创建或恢复业务 session；服务端验证设备、workspace 和 session 的关系。
7. supervisor 分配独立的远端工作目录和 worker。
8. 生成 MCP 配置及必要的上下文说明。
9. worker 启动，确认认证可用、桥接 MCP 已加载、工具集合符合预期。
10. local-host 与服务端完成操作账本对账。
11. 客户端显示就绪，允许提交第一条用户消息。

第 9 或 10 步失败时不得进入“可以自动执行”的状态。

### 11.2 业务会话状态

~~~text
NEW
  -> CONNECTING
  -> STARTING_AGENT
  -> READY
  -> RUNNING
  -> WAITING_LOCAL_TOOL / WAITING_USER
  -> RUNNING
  -> READY

可中断状态：
  RECONNECTING
  PAUSED_LOCAL_OFFLINE
  AUTH_REQUIRED
  RECONCILING
  FAILED
  CLOSED
~~~

会话状态与单个命令状态不能合并。一个会话 READY 时，用户允许的开发服务器可能仍在本地运行。

同一会话默认串行提交 turn。用户在运行中追加消息时，MVP 采用明确的队列或“中断后发送”操作，不把新提示悄悄混入正在执行的工具事务。

### 11.3 一个工具调用的生命周期

~~~mermaid
sequenceDiagram
    participant A as VPS 官方 Claude Code
    participant M as VPS MCP Bridge
    participant S as Relay Server
    participant L as Local Host
    participant U as 本地界面
    A->>M: 调用工具
    M->>M: 分配并持久化 operation_id
    M->>S: 派发工具请求
    S->>L: tool.execute
    L->>L: 校验绑定、参数、真实环境和策略
    alt 需要用户确认
        L->>U: 展示具体操作或 diff
        U->>L: 同意或拒绝
    end
    L->>L: 执行或拒绝，并保存结果
    L-->>U: 进度、日志、结果
    L-->>S: 已持久化的工具结果
    S-->>M: 对应操作结果
    M-->>A: MCP 工具结果
    A->>A: 继续 Agent 循环
~~~

### 11.4 绑定关系

每个业务 session 固定绑定：

~~~text
owner_id
device_id
workspace_id
workspace_generation
execution_target_id
runtime_session_id
worker_epoch
policy_revision
~~~

移动项目、换 WSL 发行版、更换执行机器等操作必须显式重新绑定或创建新会话。不能只因路径字符串相同，就把另一台机器当作原项目。

### 11.5 恢复原则

模型会话恢复与本地副作用恢复是两个动作。

先找回官方 runtime_session_id，再核对本地所有未终结操作，最后才允许新的模型 turn。不能先让模型“继续完成任务”，再慢慢检查上次命令有没有执行。

## 12. Bridge 协议草案 v1

### 12.1 传输与接口

外部连接使用 HTTPS/WSS。MVP 不公开本地监听端口，不要求家庭路由器转发端口。

候选 HTTP 入口：

~~~text
GET /healthz        最小存活检查，不返回设备、账号或会话
GET /v1/bridge      WebSocket upgrade，必须完成设备鉴权
~~~

设备注册、吊销和服务管理优先通过服务端管理 CLI 或受保护的管理接口完成。不要因为有 healthz 就公开管理后台。

bridge 的 Authorization 仅用于连接个人中转站。它不是 Anthropic 的 Authorization，也不能被转发给 Anthropic。

### 12.2 协议协商

连接建立后交换：

~~~json
{
  "jsonrpc": "2.0",
  "id": "hello-1",
  "method": "connection.hello",
  "params": {
    "protocol_version": "1.0",
    "client_version": "0.1.0",
    "device_id": "device_01",
    "capabilities": [
      "tool.read",
      "tool.edit",
      "process.run",
      "process.cancel",
      "events.replay"
    ],
    "last_server_cursor": 102
  }
}
~~~

服务端返回协议版本、连接 ID、支持能力、必要限制及恢复状态。版本不兼容时明确拒绝，不能降级到不受约束的任意 Shell。

设备 ID 是路由标识，不是鉴权凭据。服务端不能仅凭客户端声称的 device_id 信任它。

### 12.3 业务请求

~~~json
{
  "jsonrpc": "2.0",
  "id": "rpc_104",
  "method": "tool.execute",
  "params": {
    "session_id": "session_01",
    "turn_id": "turn_03",
    "worker_epoch": 7,
    "workspace_id": "workspace_01",
    "workspace_generation": 2,
    "operation_id": "operation_209",
    "tool": "edit_text",
    "input": {
      "path": "src/login.ts",
      "old_text": "return false;",
      "new_text": "return user !== null;",
      "expected_revision": "sha256:PLACEHOLDER",
      "expected_matches": 1
    },
    "policy_revision": 4
  }
}
~~~

工具输入只是数据。路径在 local-host 解析，不在 VPS 解析成本地文件。

### 12.4 ID 的职责

| 标识 | 生命周期 | 用途 |
| --- | --- | --- |
| JSON-RPC id | 一次 RPC | 关联请求响应，不承担副作用去重 |
| operation_id | 一次实际操作及其重传 | 持久化去重和恢复 |
| session_id | 一段业务对话 | 连接本地项目与远端运行时 |
| turn_id | 一轮用户驱动的工作 | 取消、队列、输出归属 |
| task_id | 一个本地后台进程/任务 | 独立于某一次连接持续跟踪 |
| worker_epoch | 一代远端会话控制者 | 拒绝旧 worker 发出的请求 |
| event cursor | 一个有序事件流的位置 | 补发和显示去重 |
| workspace_generation | 一次 workspace 绑定代次 | 防止会话指向被换掉的目录 |

不要假定官方 tool_use_id、MCP 请求 ID 和本项目 operation_id 是同一个东西。MCP handler 未必提供上层模型工具 ID。适配器应保存自己能确定的关联关系。

worker 重启后出现的新 MCP 请求 ID，不自动证明它是全新业务操作。存在未完成副作用时，必须先恢复/核查，不能靠新 ID 绕过去重。

### 12.5 方法集合

| 方法 | 方向 | 含义 |
| --- | --- | --- |
| connection.hello | 本地 → VPS | 版本、能力与恢复协商 |
| session.create | 本地 → VPS | 创建会话并绑定 workspace |
| session.resume | 本地 → VPS | 恢复指定会话 |
| session.describe | 双向 | 核对当前状态和绑定 |
| session.close | 本地 → VPS | 关闭会话，后台任务另按策略处理 |
| turn.submit | 本地 → VPS | 提交提示，带稳定 client_message_id |
| turn.cancel | 本地 → VPS | 中断指定 turn |
| tool.execute | VPS → 本地 | 执行本地能力 |
| operation.status | 双向查询 | 查询既有操作状态 |
| operation.cancel | VPS/UI → 本地 | 取消操作，可能返回未能完全取消 |
| task.status / task.output | VPS/UI → 本地 | 查询后台任务 |
| workspace.describe | VPS → 本地 | 请求真实目标环境和项目摘要 |
| workspace.changed | 本地 → VPS | 通知缓存或版本过期 |
| event.emit | 双向通知 | 进度、消息、权限状态、任务事件 |
| events.ack / events.resume | 双向 | 确认游标与补发 |

用户批准事件通常由 bridge-cli 经本机 IPC 直接交给 local-host。远端只需知道等待、批准或拒绝的状态，不必把一次本地确认绕远端一圈才生效。

### 12.6 成功与失败结果

~~~json
{
  "jsonrpc": "2.0",
  "id": "rpc_104",
  "result": {
    "operation_id": "operation_209",
    "status": "SUCCEEDED",
    "output": {
      "path": "src/login.ts",
      "before_revision": "sha256:BEFORE",
      "after_revision": "sha256:AFTER",
      "changed_lines": 1
    }
  }
}
~~~

协议格式错误、未认证、会话不存在可以用 JSON-RPC error。

已经被接受的工具操作出现文件不存在、权限拒绝、命令退出非零等情况，使用工具结果中的明确状态和错误码。mcp-bridge 再转换成 MCP 的错误结果，供模型理解。不要混淆“网络送达失败”和“命令执行失败”。

候选错误码：

~~~text
AUTH_REQUIRED
DEVICE_REVOKED
SESSION_NOT_FOUND
WORKSPACE_OFFLINE
WORKSPACE_MISMATCH
STALE_WORKER
POLICY_CHANGED
PERMISSION_DENIED
APPROVAL_EXPIRED
FILE_NOT_FOUND
FILE_CHANGED
AMBIGUOUS_EDIT
PATH_NOT_ALLOWED
UNSUPPORTED_ENCODING
UNSUPPORTED_CAPABILITY
PROCESS_START_FAILED
PROCESS_EXIT_NONZERO
CANCEL_PENDING
OUTCOME_UNKNOWN
OUTPUT_TRUNCATED
~~~

### 12.7 事件顺序、背压和边界

- 每个事件流有独立且单调的序号；不依赖跨机器时钟排序。
- 接收端先持久化关键事件再确认。
- 重放可能产生重复事件，UI 按事件 ID 去重。
- 控制消息和取消消息优先于大量日志块。
- 单条消息、队列长度、磁盘缓存均设置明确上限。
- 大文件和图片使用有界分块或独立 blob 引用，不把无限 base64 塞入一条 RPC。
- 摘要和截断必须明确标注，不能把截断输出当作完整日志。
- 心跳只说明连接活着，不代表任务完成或得到用户批准。

初始可调默认值示例：JSON 消息上限 1 MiB、附件块 256 KiB、15 秒连接心跳、连续 3 次心跳未响应进入重连状态。它们是起始配置，不是经过性能测试的最终值。

## 13. 本地工具契约

### 13.1 工具面向模型的形式

建议工具保持明确职责，例如：

~~~text
workspace_info
read_file
list_files
search_text
edit_text
write_file
run_command
task_status
task_output
task_cancel
ask_user
~~~

MCP 中会出现类似 mcp__local_bridge__read_file 的名称。TUI 可以显示为“读取文件”，但不要假定它就是官方内置 Read，或者宣称所有原生权限规则会自动套用。

每个工具描述明确：执行位置、路径基准、是否会修改数据、输入输出限制、取消语义和失败条件。

### 13.2 workspace_info

返回 workspace ID、显示路径、平台、Shell 类型、大小写语义、允许的额外目录、必要 runtime 版本、Git 摘要、配置版本。

默认不返回完整环境变量、所有主机信息、SSH 来源信息、网络接口列表或凭据。

当前 Shell 的实际选择是配置事实，不由模型随意声明。需要切换目标时走显式操作。

### 13.3 read_file

输入建议包含 path、可选行区间或字节区间、最大返回大小。

输出应包含：

- 实际读取范围。
- 文件内容或允许的媒体内容块。
- 编码和换行符信息。
- 文件版本标识。
- 是否只读取部分内容。
- 展示路径与内部 canonical path 的区分。

版本标识优先基于内容及必要元数据，不仅依赖 mtime。部分读取不能被解释为已经读取整个文件。

不要为“方便模型”自动上传同目录的其他文件。

### 13.4 list_files 与 search_text

在本地执行，优先调用本地搜索程序或成熟的库。

使用参数数组启动搜索程序，不通过拼接 Shell 字符串处理用户提供的搜索词。

支持工作区根、相对目录、忽略规则、命中数量限制、大小限制和结构化结果。搜索输出包含本地路径、行号与选定上下文。

符号链接处理策略要明确，不能仅靠字符串前缀判断是否仍在允许目录内。

### 13.5 edit_text

推荐输入：

~~~typescript
type EditTextInput = {
  path: string;
  expected_revision: string;
  old_text: string;
  new_text: string;
  expected_matches: number;
};
~~~

处理步骤：

1. 确认 workspace、会话和授权范围。
2. 解析本地真实路径，检查链接与文件类型。
3. 读取当前内容，核对版本。
4. 确认匹配数量符合 expected_matches。
5. 生成拟修改内容与 diff。
6. 应用本地 hooks 和策略；参数变化后重新校验。
7. 需要时获取绑定到该 diff/参数的用户批准。
8. 临近写入再次核对内容，按文件锁和版本策略处理冲突。
9. 保存编辑前内容与操作记录。
10. 写入并更新版本、read-state、诊断和事件。

多个本项目操作对同一文件应串行化。外部编辑器不会一定遵守我们的锁；版本检查、文件观察和原子替换可以减少竞争，但不能宣传为对任意外部写入都具有数据库式事务保证。

### 13.6 write_file

区分创建与覆盖：

- 创建：默认要求目标不存在。
- 覆盖：需要 expected_revision。
- 大小、编码、父目录创建规则明确。
- 不通过“读取失败就当新文件”绕过覆盖检查。
- 文件权限、BOM、CRLF/LF 等按本地语义处理。

删除、重命名、批量修改可后续增加专门工具。若通过 Shell 执行，则受 Shell 的真实权限和用户批准约束，不能假定文件工具的根目录限制会自动约束 Shell。

### 13.7 run_command

推荐明确区分两类输入：

- exec：程序与参数数组，避免额外 Shell 解析。
- shell：用户允许的命令字符串，交给选定的本地 Shell。

~~~typescript
type RunCommandInput = {
  cwd: string;
  mode: "exec" | "shell";
  program?: string;
  args?: string[];
  command?: string;
  timeout_ms: number;
  background: boolean;
  pty: boolean;
};
~~~

环境默认来自本地 session。远端不能随意覆盖 PATH、HOME、加载器变量或注入任意凭据。需要覆盖时使用经本地策略允许的参数。

输出包括任务 ID、stdout/stderr 片段、退出码或运行状态、截断信息、日志游标。

### 13.8 长任务的调用方式

MCP 调用本身有超时及版本相关行为，WebSocket 心跳不能保证原生 MCP 等待会被无限延长。

因此较长命令应采用：

~~~text
run_command -> 批准并启动 -> 返回 task_id
task_status/task_output -> 查询或有限时间等待
task_cancel -> 取消
~~~

短命令可以直接等待结果。不要让一个 MCP 调用在无人审批或长测试期间无限挂起。

### 13.9 ask_user

用户问题在本地 UI 展示，回答与具体请求关联，取消和超时要返回可辨识结果。

模型不能生成 permission.approved 事件来伪装用户同意。ask_user 的普通回答也不自动授权后续文件写入。

## 14. 权限、项目信任与安全边界

### 14.1 两层检查

远端运行时层只开放本项目认可的工具，防止模型直接用 VPS 内置工具执行项目操作。

本地执行层对每个请求检查：

~~~text
已认证设备连接
  -> 正确的会话与 workspace 绑定
  -> 有效 worker_epoch 和策略版本
  -> 输入格式
  -> 真实路径/命令/环境校验
  -> hooks 与本地规则
  -> 必要的用户批准
  -> 重新核对被批准的动作
  -> 执行
~~~

任何一层通过都不能取代另一层。

### 14.2 本地策略模式

第一版建议仅支持可解释的模式：

- ask：需要批准的操作逐次确认。
- read-only：限制到已实现且经审核的只读工具，不把任意 Shell 自动归类为只读。
- accept-edits：自动接受允许范围内的文件编辑；Shell 仍单独处理。

名称和语义是本项目自己的策略，不要暗示已经复现官方全部权限模式。官方自动分类器、命令规则和项目信任行为需要另行实现和测试。

规划模式必须由执行端限制副作用，不能只在系统提示中告诉模型“请不要修改”。

### 14.3 批准的绑定

批准记录至少关联：

~~~text
operation_id
workspace_id + generation
tool
canonical input digest
policy revision
approval scope
expiry / invalidation condition
~~~

修改参数、切换目录或策略变化后，旧批准不能继续使用。允许整个会话或整个命令类别时，界面要清楚说明范围。

本地执行服务的内部批准对象不从远端消息直接反序列化成可信对象。

### 14.4 不把 Shell 当作受根目录约束的文件 API

cwd 只是工作目录，不是沙箱。普通用户权限下的 Shell 能访问该用户有权访问的其他文件，也可能通过 Git hooks、构建脚本或依赖脚本执行更多操作。

若需要强隔离，应增加真正的 OS 沙箱/容器或受限账号，并验证其与 Windows/WSL 工具链的兼容性。没有部署这些机制时，文档和界面必须如实说明权限范围。

### 14.5 MCP 与项目配置的信任

本地项目提供的 hooks、MCP command、skills 脚本本质上可能执行代码。首次信任只针对已展示的项目配置范围，配置改变后按策略重新确认。

远端生成的 MCP 配置只启动可信 mcp-bridge，不直接执行从本地项目上传的 command 字符串。

### 14.6 超时与用户离开

用户未回答不等于批准。

审批超时后，操作进入拒绝或取消状态；如果迟到的回答到达，不得让已经结束的请求再次执行。

客户端退出后，等待人工批准的操作保持暂停或失效。只有用户预先允许的后台任务才按其既定策略继续。

### 14.7 VPS 自身隔离

禁止内置 Bash/Read 等模型工具，并不能证明官方进程、插件或启动 hook 完全不访问 VPS。

应组合使用：专用账号、干净远端目录、固定 MCP 配置、明确的配置加载范围、最小文件权限、版本检查，以及必要的系统隔离。不能拿一个工具名单当作完整沙箱。

## 15. 本地项目上下文、配置、skills 与 hooks

### 15.1 Workspace Context Provider

单独实现本地上下文服务，不让这些读取散落在各个工具里。

候选接口：

~~~typescript
interface WorkspaceContextProvider {
  describeWorkspace(): Promise<WorkspaceDescription>;
  getInstructionManifest(): Promise<InstructionManifest>;
  getGitSnapshot(): Promise<GitSnapshot>;
  listCapabilities(): Promise<CapabilityManifest>;
  watchChanges(): AsyncIterable<WorkspaceChange>;
}
~~~

它读取的是真实本地项目；VPS 只能请求相应信息。

### 15.2 上下文分层

| 层 | 内容 | 更新策略 |
| --- | --- | --- |
| 固定执行描述 | 平台、Shell、workspace 标识 | 绑定变化时重建会话或重新确认 |
| 项目指令 | CLAUDE.md、选定规则 | 版本化更新，保留来源 |
| Git 快照 | 分支、状态、必要 diff | 启动及相关操作后重新读取 |
| 文件内容 | Agent 实际需要的片段 | 按读取获取，修改时失效 |
| 工具能力 | 可用工具及限制 | 协议协商或配置变化时更新 |
| 用户偏好 | 当前项目授权和显示设置 | 本地保存 |

不要每轮发送整个代码仓库或重复附加全部历史。缓存必须用版本标识失效，不能假定启动时的 Git 状态一直正确。

### 15.3 CLAUDE.md 和层级规则

先实现清楚定义的子集，例如 workspace 根和选定用户级指令，再逐步支持子目录规则及按路径触发的内容。

实现每一层时，记录来源、作用范围、加载顺序和版本。若尚未复现官方优先级，就明确称为兼容子集，不要悄悄合并成一段无法追踪的文本。

远端默认系统提示可能描述 VPS Linux。追加的执行目标描述必须消除歧义；不能指望模型自行猜出所有工具实际在 Windows。

### 15.4 hooks

与用户项目有关的 hooks 在本地执行，使用本地目录和选定环境。

需要明确：

- 什么时候触发，以及相同事件重放是否会重复触发。
- hook 修改输入后如何重新校验和审批。
- hook 的 stdout/stderr 如何进入上下文或 UI。
- hook 的超时、取消和失败策略。
- hook 本身产生的副作用如何记录。

不要让远端官方 hook 和本地兼容 hook 各运行一次。

### 15.5 skills 与斜杠命令

纯文本指令可以读取后随上下文提交。包含脚本或工具依赖的 skill 必须显式指定由本地执行，不能直接复制到 VPS 后让运行时自动启动。

第一版可以只支持选定文本 skills。复杂官方技能加载、插件依赖、动态发现和多 Agent 工作流另立兼容性任务。

### 15.6 本地 MCP、LSP 与编辑器

后续可允许 local-host 代理用户已授权的本地 MCP 工具，但要保持工具来源、权限边界和服务器生命周期清晰。

不要把用户的本地 MCP 凭据、编辑器认证 token 或 LSP 进程迁到 VPS。只传递被授权调用的结果。

未保存的编辑器缓冲区与磁盘文件可能不同。MVP 以磁盘为准；接入编辑器后应明确缓冲区版本，不把它与文件 hash 混用。

## 16. Windows、WSL、Linux 与进程管理

### 16.1 执行目标识别

| 启动环境 | local-host 所在位置 | 默认路径解释 |
| --- | --- | --- |
| WSL 内启动 | 同一发行版 | Linux 路径；/mnt/c 仍按该环境语义处理 |
| Windows 原生启动 | Windows | 盘符、UNC、大小写和 Windows 链接语义 |
| Linux 服务器启动 | 该服务器 | 服务器本地路径 |

不要自动把 Windows 会话切到 WSL，或把某 WSL 发行版切到另一发行版。如果提供显式目标切换，目标变更需要新的绑定与环境核对。

### 16.2 环境继承

bridge-cli 启动时把必要的调用者环境在本机交给 local-host，形成会话级快照。

这样可以保留用户刚激活的 venv、conda、nvm 或其他工具链环境。不能直接使用常驻 daemon 启动时的旧 PATH。

环境快照不默认上传。远端只获得完成任务所需的描述或特定工具输出。

### 16.3 Windows 专项

- Shell 使用已配置且实际存在的 PowerShell、Git Bash 或其他受支持实现。
- 执行参数正确处理引号、空格、Unicode 和退出码。
- 文件读写识别 BOM、CRLF/LF、可能的编码差异。
- 进程树取消使用合适的 Windows 机制；只杀父 PID 不视为通过验收。
- 交互式程序需要适配 Windows 伪终端能力。
- junction、符号链接、UNC 路径与设备路径需要专门测试。
- 输出中的 ANSI/控制序列在 TUI 中按受限方式处理。

不建议在第一版自行实现完整终端模拟器。选用维护中的实现前核对平台支持，并做最小原型。

### 16.4 Linux/WSL 专项

- 记录进程组或任务管理器内的稳定 handle。
- 取消应覆盖相关子进程。
- Shell 环境和非交互登录行为要明确，不能假定 bash -lc 等同用户当前交互环境。
- WSL 中执行命令的生命周期应由该发行版内的 host 管理。
- 避免用远端 Linux 的路径展开、工具探测结果替代本地结果。

### 16.5 后台任务

后台任务最少记录：

~~~text
task_id
session_id / turn_id / operation_id
execution_target_id
command digest
working directory
start time
process handle
stdout/stderr log references
status / exit code
cancel requested / cancel confirmed
disconnect policy
~~~

PID 可能复用，恢复时不能仅凭旧 PID 随意杀进程。

### 16.6 取消语义

“取消已请求”与“进程已停止”分开。

顺序建议：本地 UI 立即通知 local-host 停止相关动作，同时发送远端 turn.cancel；local-host 尝试温和终止，超时后按配置升级，最终返回确认或状态不明。

终止进程不等于撤销它已经完成的文件修改、网络请求、发布或数据库操作。界面不能显示“已全部回滚”。

## 17. 持久化、幂等与故障恢复

### 17.1 本地操作日志

使用本地持久化 journal，至少包含：

~~~text
operation_id (unique)
session_id
turn_id
worker_epoch
workspace_id / generation
tool
input_digest
policy_revision
state
approval_reference
task_reference
result_reference
created_at / updated_at
uncertainty_reason
~~~

同一个 operation_id 携带不同 input_digest 必须拒绝，不能用新参数覆盖旧记录。

### 17.2 操作状态机

~~~text
RECEIVED
  -> VALIDATING
  -> WAITING_APPROVAL
  -> PREPARED
  -> RUNNING
  -> SUCCEEDED / FAILED / CANCELLED

任意出现无法判定的崩溃窗口：
  -> UNKNOWN
~~~

已接受但被拒绝的操作可用 DENIED 终态。审批等待不能因为重连被恢复为默认允许。

### 17.3 写入前日志与其边界

执行有副作用操作前保存 intent，之后尽快保存结果。SQLite 事务能保护 journal 自身，但不能自动与文件系统、外部命令或网络副作用形成一个原子事务。

例如：

~~~text
保存“准备执行”
-> 命令成功发布
-> 本地机器突然断电
-> “已成功”尚未落盘
~~~

此时不得自动重试发布。需要进入 UNKNOWN，使用可验证的外部状态或用户决策来解决。

### 17.4 去重行为

| 既有状态 | 收到同一 operation_id 时 |
| --- | --- |
| SUCCEEDED / FAILED / DENIED | 返回已保存结果 |
| RUNNING | 返回/订阅原任务 |
| WAITING_APPROVAL | 恢复同一确认，不创建第二份操作 |
| PREPARED | 根据是否已启动的证据恢复，不盲目执行 |
| UNKNOWN | 停止自动重试，进行核查 |
| 无记录 | 完整验证后接受 |

JSON-RPC 重传不是新操作。模型在恢复后生成一个新工具调用则是另一回事；必须先把旧操作结果/不确定状态带回上下文，必要时阻止相关副作用继续执行。

### 17.5 服务端持久化

relay-server 保存设备、workspace 绑定、会话映射、消息投递记录、事件游标和 worker 代次。

官方 Claude Code 自己保存的 transcript 是运行时会话恢复依据。业务层不随意修改其格式，不把自己的 event log 直接当成官方 transcript。

备份应覆盖业务数据库、官方会话资料及必要配置，但凭据的备份与访问权限必须单独管理。

### 17.6 三种断线

| 故障 | 本地行为 | VPS 行为 | 恢复条件 |
| --- | --- | --- | --- |
| UI 关闭，host 在线 | 已批准任务按策略继续，人工审批暂停 | 会话可保留，不能伪造用户回答 | UI 重新连接并恢复事件 |
| 本地到 VPS 断线 | 不接受过期新任务；已启动任务按策略处理 | 暂停新的本地工具派发 | 认证、epoch、操作账本及游标核对 |
| VPS/worker 崩溃 | 保存任务与结果，不自主调用模型 | 重建 worker，先对账后 resume | 未决副作用得到明确处理 |

长时间离线的继续/终止策略应在启动任务时确定。例如用户明确保留的开发服务器可以继续；等待用户批准的动作不会自行启动。

### 17.7 控制者代次与防止双执行

每个会话只有一个有效控制者。重建 worker 时增加 worker_epoch，并更新 local-host 所认可的代次。

旧 worker 即使稍后恢复连接，它的请求也应被拒绝。不要同时运行两个进程对同一 transcript 和 workspace 发号施令。

### 17.8 超时分类

连接超时、审批超时、模型等待超时、工具执行超时、日志读取超时、后台任务存活时间分别配置。

一个网络请求超时不代表执行超时；一个工具等待超时也不意味着后台进程已经终止。状态变化必须有执行端证据。

## 18. 性能、流式体验与资源管理

### 18.1 主要延迟来源

总耗时包含本地到 VPS 的传输、VPS 到模型服务的请求、模型推理、本地工具执行和必要的往返等待。

仅桥接增加的串行等待可以粗略表示为：

~~~text
额外等待约等于：必须串行的工具批次数 × 本地到 VPS 的 RTT
~~~

例如 RTT 为 80 毫秒、30 批串行工具调用，单这一项约 2.4 秒。这是示例计算，不是本项目实测。

### 18.2 优化顺序

1. 先测量，不先引入复杂缓存。
2. 本地 UI 立即显示已经收到的工具进度。
3. 合并适合批量读取的请求，避免逐行往返。
4. 并行执行经确认无副作用且互不依赖的读操作。
5. 缓存工具描述和带版本的项目指令。
6. 将日志原文留在本地，模型按需获取相关部分。
7. 对断线缓存和慢客户端实行背压。

不要为了减少一次往返而跳过权限确认、版本检查或任务持久化。

### 18.3 限制与公平性

第一版默认一个活动模型 turn。多个独立会话可以排队；用户明确需要后再增加有限并发。

每个会话设置队列、日志、附件、worker 生命周期等资源限制。实际内存预算必须根据 VPS 配置和测量决定，不在没有环境信息时编造可支持的并发数。

对外部限流保留真实错误和等待信息，不用多个 worker 绕过订阅限制。

### 18.4 流式显示一致性

文本增量、完整助手消息和最终结果可能包含重复信息，adapter 必须定义一种规范化策略，避免 TUI 显示两遍。

只展示官方输出中实际存在且允许展示的内容，不尝试重建未返回的内部推理。

发生断流时保留已有文本并标记“未完成”。不能追加虚假的结束标识让 UI 误认为任务成功。

## 19. 凭据、日志和服务暴露

### 19.1 两套身份体系

| 身份 | 目的 | 管理者 |
| --- | --- | --- |
| Anthropic 订阅登录 | 官方 CLI 调用 Claude | 官方 CLI 与用户 |
| bridge 设备身份 | 客户端接入自己的 VPS 服务 | 本项目 |

两套凭据不能复用。

MVP 可以使用每设备独立的高熵访问凭据，经 TLS 传输，服务端保存适当的验证材料并支持吊销。使用成熟库，不自行设计加密算法。

本机 IPC 也需要文件权限/用户身份限制，防止其他本地用户借 host 执行命令。

### 19.2 日志分层

默认运行日志只记录：

- 版本、组件、会话与操作标识。
- 状态变化、延迟、输出大小、错误类别。
- 不含秘密的工具类别和必要参数摘要。

默认不记录：

- Authorization、Cookie、API key、OAuth token。
- 全量环境变量。
- 完整代码、提示词和命令输出。
- 登录响应正文。

调试模式需要明确启用、有保留期限并提示内容范围。导出诊断前做脱敏。官方 CLI 自己的会话记录另行管理，不能因自有日志不存正文就宣称系统没有存正文。

### 19.3 附件与资源限制

附件必须属于已认证 session，限制大小与类型；路径下载、压缩包解包和外部 URL 读取不属于 MVP 自动能力。

不能让任意客户端利用 VPS 的工具路由读取另一个设备的文件，也不能让任意 URL 参数把服务变成开放代理。

### 19.4 服务端对本地的权限

VPS 被攻破时，攻击者可能尝试发送工具请求。local-host 的绑定、能力范围和本地审批是重要防线，但已被用户广泛授权的 Shell 仍然具有相应权限。

因此应保留最小授权、设备吊销、停止所有会话和本地紧急断开功能。不能把“有审批”当作对已授权任意命令的完全保护。

## 20. 部署与日常运维设计

### 20.1 当前未知的基础设施信息

原始交接时未提供 VPS 信息。2026-10-23 已通过用户指定的 SSH 别名核对 VPS 系统、资源和现有服务，见第 30 节。真实主机地址、私钥和设备凭据不写入可发布的配置样例；域名/正式证书方案仍未选定。

新 session 可以先完成本地代码与 mock 测试。部署步骤需要这些实际信息时再获取，不应因此阻塞所有开发。

### 20.2 建议布局

VPS 路径仅作部署设计示意：

~~~text
/opt/personal-relay/              发布程序与固定版本
/etc/personal-relay/              服务配置
/var/lib/personal-relay/          数据库、会话元数据、生成配置
/var/lib/personal-relay/sessions/ 每会话独立基础设施目录
/run/personal-relay/              本机 IPC
~~~

官方 CLI 的账户配置按其支持的路径和该运行账号管理。不要为隔离会话而到处复制同一份 OAuth 凭据。

客户端数据位置使用各平台适当的用户应用目录。项目中的临时文件只有在用户项目操作确实需要时才创建，不把本地状态数据库写进 Git 仓库。

### 20.3 网络部署

优先保持后端只监听回环或私有接口，由有 TLS 的入口转发 WSS。

反向代理需要支持 WebSocket upgrade、合理的长连接超时和连接大小限制。代理访问日志不得保存鉴权信息。

不因为“只有自己用”就暴露无认证的远程命令服务。

首次演示可通过受保护的 SSH 隧道连接服务，验证功能后再完善正式客户端连接。这是 bridge 的传输选择，不是把主 Agent 改回本地。

### 20.4 官方登录维护

初始登录是管理员在 VPS 上的官方 CLI 操作。浏览器授权遵循官方流程，不经自建网页登录页收集账号密码。

正常客户端只显示认证状态摘要。需要重新登录时给出维护动作，不把认证网页嵌入为自建 Claude 登录服务。

### 20.5 进程管理

服务可交给 systemd 或等价 supervisor 管理，worker 生命周期由业务 supervisor 管理。

服务重启策略只重启服务进程，不自动重放上一条用户任务。启动后进入恢复检查，确认未决操作再接收新 turn。

不能通过自动删除 transcript 或清空本地 journal 解决恢复错误。

### 20.6 版本管理

记录以下版本：

~~~text
bridge server
bridge client
bridge protocol
local-host
official Claude Code
MCP bridge
runtime dependencies
OS / execution target
~~~

固定官方 CLI 与依赖版本，升级先运行契约测试和最小真实联调。若安装渠道会自动升级，研究部署版本支持的控制方式并核对，不能假定锁定已经生效。

### 20.7 备份与回滚

升级前备份业务数据库、配置和必要会话数据。确认备份的访问权限及是否包含敏感内容。

回滚包括程序版本与兼容的数据库格式。文件编辑撤销另由本地历史处理，不能与服务部署回滚混为一谈。

停止项目应能：

1. 停止接受新的 turn。
2. 显示并处理运行中的任务。
3. 停止 worker。
4. 吊销或暂停设备凭据。
5. 保留可恢复记录。
6. 按用户选择删除自有服务数据；不误删用户项目和现有官方配置。

## 21. 建议代码组织与技术选择

### 21.1 起始技术选择

建议业务层先统一使用 TypeScript，便于共享协议 schema 和与现有生态集成。选择实施时受支持的 Node.js 版本并锁定，不在本文虚构已经验证的版本组合。

本地进程管理和伪终端功能优先使用成熟实现。Windows 如果存在必须用原生组件解决的能力，再增加小范围平台适配，不一开始就重写整个系统为多语言。

SQLite 作为个人单节点服务和本地 journal 的起点。TLS 交给成熟入口或运行环境，避免手写。

包管理器、TUI 库、WebSocket/MCP 库在 P0 根据实际平台支持选择。选择后写入 lockfile 和版本说明。

### 21.2 仓库结构草案

~~~text
personal-claude-relay/
  apps/
    relay-server/
    bridge-cli/
    local-host/
    mcp-bridge/
  packages/
    protocol/
    runtime-adapter/
    local-tools/
    workspace-context/
    permissions/
    operation-journal/
    task-runner/
    event-store/
    diagnostics/
  platform/
    linux/
    windows/
    wsl/
  tests/
    contract/
    integration/
    fault-injection/
    fixtures/
    platform/
  docs/
    DESIGN.md
    DECISIONS.md
    AUTH.md
    PROTOCOL.md
    COMPATIBILITY.md
    RUNBOOK.md
    TEST-REPORT.md
  deploy/
    systemd/
    containers/
    reverse-proxy/
  examples/
    minimal-workspace/
~~~

这是新项目的建议结构，不意味着要复制第三方仓库。第三方资料可以放在独立研究目录，只记录链接和 commit；是否 vendoring 另行核对许可。

### 21.3 模块边界

- protocol：业务消息 schema、版本协商和错误码，不依赖官方内部类型。
- runtime-adapter：唯一了解官方 CLI 输入输出细节的模块。
- local-tools：对真实本地资源执行操作，不依赖网络连接对象。
- permissions：每次执行必须经过，返回明确结果。
- operation-journal：可靠地记录和查询操作，不凭内存 Map 当持久化。
- task-runner：进程和输出生命周期，不依赖 TUI 是否在线。
- event-store：事件游标、补发、去重。
- workspace-context：项目指令、Git 和执行目标描述。
- diagnostics：脱敏状态和诊断导出。

### 21.4 三个开发用替身

必须可以在没有真实 Claude 登录的情况下开发大部分功能：

1. Fake Agent：按脚本产生工具请求和流式事件。
2. Fake Workspace：临时项目、可控文件变更及短命令。
3. Faulty Transport：可注入断线、重放、乱序通知、慢消费者与消息丢失。

这些替身不能替代最终真实 CLI 和账号联调，但能避免每次测试都消耗订阅用量。

## 22. 失败处理与不允许的自动回退

| 失败 | 正确处理 | 不允许的回退 |
| --- | --- | --- |
| 本地 host 不在线 | 暂停依赖本地工具的工作 | 改在 VPS 执行 |
| 本地文件找不到 | 返回真实路径错误 | 搜索/编辑 VPS 同名文件 |
| 订阅认证失败 | 要求官方重新登录或处理账号状态 | 自动用未知 API Key 或其他账号 |
| 工具配置缺失 | 阻止进入就绪状态 | 启用全部内置工具凑合 |
| MCP 连接失败 | 明确报错，保留诊断 | 让模型用远端 Shell 代替 |
| 权限超时 | 拒绝或暂停 | 超时自动批准 |
| 文件版本冲突 | 返回 FILE_CHANGED，重新读取 | 强制覆盖 |
| 命令结果丢失 | 查询 journal/task，必要时 UNKNOWN | 直接重新执行 |
| worker 崩溃 | 恢复并对账 | 重发完整用户任务 |
| 未支持斜杠命令 | 告知当前不支持 | 猜测其原生命令语义 |
| 模型/订阅限流 | 正常等待或交给用户处理 | 多账号/多实例轮换规避 |
| 版本不兼容 | 停止或明确降级支持的功能 | 悄悄忽略关键字段继续写文件 |

## 23. 分阶段执行计划与退出条件

每阶段必须有可检查的产物和测试结果。不能只写“已完成设计”就视为实现，也不能把 mock 测试结果写成真实部署成功。

### P0：验证官方运行时与订阅契约

目标：确认选定架构最核心的接口可用，尽早发现不可行之处。

任务：

1. 记录官方 CLI 的来源、版本与实际帮助信息。
2. 在用户授权的 VPS 环境中确认个人订阅认证，输出脱敏方式摘要。
3. 确认没有 API Key/网关凭据覆盖订阅。
4. 运行最小 -p 请求，确认使用订阅路径。
5. 注册仅含一个无副作用工具的测试 MCP。
6. 测试 stream-json、初始化事件和实际工具调用。
7. 验证禁用内置项目工具后，没有意外的远端文件/Shell能力。
8. 测试多轮输入或明确 session ID 的恢复方式。
9. 测试中断、关闭 stdin、SIGTERM 与 worker 退出后的状态。
10. 验证配置隔离；不得为了隔离而引入破坏 OAuth 的 bare 模式。

产物：

- docs/COMPATIBILITY.md：实际测试的版本、参数组合与限制。
- 脱敏事件 fixtures。
- 最小 runtime adapter。
- 一份真实测试报告，明确哪些测试未运行。

退出条件：个人订阅、官方运行时、受控 MCP、流式输出和会话标识均已证实；或清楚记录具体阻塞，先继续不依赖它的本地开发。

若没有 VPS 访问或登录条件，可以完成 mock contract 和代码骨架，但 P0 的真实验证不得标为通过。

### P1：打通最小远端 Agent／本地工具闭环

目标：在 Linux/WSL 上用真实本地文件完成一次任务。

任务：

1. 实现设备鉴权与 WSS 连接。
2. 实现 session.create、turn.submit、event.emit。
3. 实现 mcp-bridge 与本地 host 的绑定。
4. 实现 workspace_info、read_file、search_text。
5. 增加 edit_text 与逐次批准。
6. 增加短命令 run_command。
7. 完成最小 CLI 展示。
8. 给每个操作增加稳定 operation_id 和持久化记录。

验收任务：用户本地临时项目中读取一个函数，修改一个明确位置，在本地运行短测试。VPS 上没有该项目副本，也没有测试产生的文件。

退出条件：证据能够说明文件和命令的执行位置，用户能拒绝修改，拒绝后文件未变。

### P2：把可靠性做到可连续使用

任务：

- 断线重连、事件补发与 UI 去重。
- 单次操作重传去重。
- 文件版本冲突和编辑快照。
- 后台任务、输出查询、进程树取消。
- worker 崩溃与会话恢复对账。
- USER WAIT、AUTH_REQUIRED、UNKNOWN 等状态。
- 限制队列、输出和日志空间。
- 基本诊断和停止功能。

退出条件：第 24 节的断线、重复投递、取消和恢复测试通过；没有用“重跑整个任务”掩盖恢复失败。

### P3：实现主要原生交互体验

任务：

- 多行输入、流式显示、清屏、历史。
- 工具进度、diff、权限交互。
- @ 文件引用和本地路径补全。
- 恢复会话与本地项目选择。
- 后台任务面板。
- 明确的斜杠命令兼容子集。
- 提示代码实际会经远端模型处理，避免错误隐私承诺。

退出条件：连续完成一项真实的小型开发任务，不需要手动 SSH 或复制命令；用户能够看懂并控制每次修改。

### P4：Windows 原生兼容

任务：

- Windows 启动与打包。
- PowerShell/Git Bash 的显式选择。
- 路径、编码、盘符、空格、Unicode、CRLF。
- Windows IPC、伪终端和进程树取消。
- WSL 多发行版与 Windows 环境不混淆。
- Windows 上的配置和凭据存储权限。

退出条件：同一套行为契约在 Windows 原生与 WSL 分别通过；不能只在 WSL 运行就宣称支持 Windows 原生。

### P5：高级项目能力与维护

任务：

- CLAUDE.md 层级与动态上下文。
- 明确范围的 hooks、skills 和本地 MCP。
- IDE/LSP 接入。
- worktree 操作。
- 根据用户需求增加子 Agent；所有子 Agent 的项目工具必须仍走本地边界。
- 少量多会话并发。
- 官方 CLI 升级兼容流水线。

各高级功能单独维护支持表，不把一个功能标记为“全支持”而只测试最简单路径。

## 24. 测试矩阵与完成定义

### 24.1 架构和认证测试

| ID | 场景 | 期望证据 |
| --- | --- | --- |
| A01 | VPS 运行官方 worker | 进程、版本、来源记录 |
| A02 | 本地仅运行客户端/执行端 | 本地主进程清单，不存在另一个模型 Agent 循环 |
| A03 | Pro／Max 实际生效 | 脱敏认证状态及最小请求成功；不输出 token |
| A04 | 残留 API Key | 检测并明确提示，不静默改计费路径 |
| A05 | 禁用远端项目工具 | 工具清单与诱导访问远端测试均符合预期 |
| A06 | 本地离线 | 无任何 VPS 项目执行回退 |
| A07 | 账号需重新登录 | 进入 AUTH_REQUIRED，无高频重试 |

### 24.2 文件与路径测试

| ID | 场景 | 期望 |
| --- | --- | --- |
| F01 | 本地独有文件 | 远端 Agent 通过桥正确读取 |
| F02 | VPS 同名文件不同内容 | 仍读取本地内容 |
| F03 | 编辑前用户改文件 | FILE_CHANGED，不覆盖新内容 |
| F04 | old_text 多处匹配 | 拒绝歧义编辑或要求明确匹配数 |
| F05 | 部分读取后改整文件 | 不把部分读取误认成完整读取 |
| F06 | 新建与覆盖 | 两种行为分别受规则约束 |
| F07 | Unicode/空格路径 | 内容与路径正确 |
| F08 | CRLF/BOM/编码 | 受支持格式保持一致，不支持的明确拒绝 |
| F09 | 符号链接/junction 越界 | 按真实目标权限判断 |
| F10 | 两会话同时写同文件 | 排序或冲突，不静默丢修改 |
| F11 | 用户移动 workspace | 绑定失效，不误操作新目录 |
| F12 | 撤销本项目文件编辑 | 检查当前版本后恢复，不覆盖后续用户修改 |

### 24.3 命令与权限测试

| ID | 场景 | 期望 |
| --- | --- | --- |
| C01 | 已激活虚拟环境 | 使用客户端启动时的本地环境 |
| C02 | npm/pytest/git | 工具与依赖来自本地 |
| C03 | 开发服务器 | 在执行端本地监听 |
| C04 | 用户拒绝 | 不启动命令、不写文件 |
| C05 | 批准后参数被修改 | 旧批准失效 |
| C06 | 超时未回答 | 不默认批准 |
| C07 | 规划模式尝试写入 | 本地执行端阻止副作用 |
| C08 | Ctrl+C | 本地开始取消，远端 turn 也收到中断 |
| C09 | 子进程与后台进程 | 正确跟踪/取消，不仅终止父进程 |
| C10 | 不支持 PTY 的环境 | 明确报错，不假装交互成功 |
| C11 | Shell 访问 workspace 外 | 根据真实 Shell 权限/批准处理，不虚称 cwd 是沙箱 |

### 24.4 故障与协议测试

| ID | 故障 | 期望 |
| --- | --- | --- |
| R01 | 重复投递同一 operation_id | 不重复执行 |
| R02 | 同 ID 不同参数 | 拒绝 |
| R03 | 执行成功后响应丢失 | 重连返回保存的结果 |
| R04 | 执行副作用后断电 | 可进入 UNKNOWN，不盲目重试 |
| R05 | worker 在工具执行中崩溃 | 恢复前先核对本地任务 |
| R06 | 旧 worker 恢复连接 | 拒绝旧 epoch |
| R07 | UI 关闭后重开 | 输出可恢复，不重复显示 |
| R08 | 大量日志/慢客户端 | 内存有界，取消消息仍能处理 |
| R09 | 协议版本不兼容 | 明确拒绝/受控降级 |
| R10 | 丢失最终模型结果 | 标记未完成，不伪造成功 |
| R11 | 两设备相同路径名 | 不串 workspace |
| R12 | 设备凭据吊销 | 新连接拒绝，既有连接按策略断开 |
| R13 | 未知事件类型 | 不崩溃，记录类型，关键能力不误判 |

### 24.5 测试层级

单元测试用于路径规则、参数摘要、状态转换和去重逻辑。集成测试用于真实本地文件/进程与 fake Agent。故障注入用于断线和崩溃窗口。真实官方 CLI 联调用于认证、MCP、恢复及版本兼容。

不要编写仅重复实现的测试来堆数量。必须覆盖会造成重复执行、误写文件、越权和错误认证路径的真实边界。

### 24.6 第一版完成定义

只有同时满足以下条件，才可以称为“个人中转站第一版可用”：

1. H1—H5 均满足。
2. 真实订阅与官方 CLI 已验证。
3. 端到端任务确实操作本地项目。
4. 权限拒绝、文件冲突、取消和重传去重通过。
5. 已知不支持功能在 COMPATIBILITY.md 中列明。
6. 有安装、启动、恢复、诊断和停止说明。
7. 有可检查的测试报告，区分 mock 与真实环境结果。
8. 不需要用户每次手工 SSH 才能完成日常开发任务。

## 25. 风险、未知项与需要验证的假设

| 项目 | 当前状态 | 如何解决 |
| --- | --- | --- |
| VPS 配置与访问方式 | 已验证 SSH；Ubuntu 26.04，1 核、约 1 GB RAM | 正式模型任务资源仍需实测 |
| 实际 CLI 版本 | VPS 已安装官方 2.1.267 并运行版本检查 | 参数组合与订阅路径尚待 P0 |
| 个人订阅＋候选参数组合 | 接口有文档，组合未实测 | P0 最小联调 |
| 长生命周期 stream-json | 未验证 | 用两轮请求、中断、关闭输入和恢复测试 |
| MCP 超时与权限等待 | 版本相关 | P0/P1 测量并使用短调用/后台任务模式 |
| 原生工具完全禁用 | 需要实际工具清单验证 | 检查 init，测试远端文件访问 |
| hooks/skills 自动加载 | 潜在误执行来源 | 干净运行环境＋明确加载范围 |
| 文件并发修改 | 不能保证与外部编辑器形成强事务 | 版本检测、冲突处理、测试竞争窗口 |
| Windows 完整体验 | 未实现 | 独立平台验收，不以 WSL 代替 |
| 官方 UI 完全一致 | 不承诺 | 维护逐项兼容表 |
| 官方 CLI 更新破坏接口 | 长期风险 | 固定版本、adapter、fixtures、升级测试 |
| 复原源码许可与可靠性 | 未完成审计 | 默认只研究，不直接作为生产运行时 |
| VPS 出口与账号稳定性关系 | 无可量化证据 | 不做保证，观察正常服务状态 |
| 多实例与订阅用量 | 不能等同无限资源 | 第一版限制并发，正常处理限制 |
| 服务端损坏后的恢复 | 未实现 | 备份、journal、故障注入 |

不需要重新确认的事项：个人订阅、主进程必须 VPS、本地工具执行、接受兼容客户端及较大开发量。

可以后续询问的真正缺失信息：VPS 登录方式与资源、首先使用 WSL 还是 Windows 原生、可用域名/证书、现有本地 Shell、是否需要某个特定插件。

## 26. 新 session 的执行指南

### 26.1 新 session 应先读什么

1. 第 0 节：用户已经决定什么。
2. 第 3 节：为什么参考 New API，但不直接部署它作为答案。
3. 第 5、9、10 节：架构与认证边界。
4. 第 12—17 节：协议、执行、权限与恢复。
5. 第 23—25 节：阶段、测试与未知项。

### 26.2 前一轮讨论不应被误读成什么

- 不是让用户在 VPS 上开发项目。
- 不是让本地官方 CLI 仅改 base URL。
- 不是已经有一份可直接运行的完整实现。
- 不是允许自动把订阅换成 API 计费。
- 不是要求复制反编译项目或 New API 全部源码。
- 不是要提供给陌生用户的公共中转服务。
- 不是承诺隐藏所有本地信息或避免一切账号限制。

### 26.3 首个开发 session 的建议动作

1. 检查用户提供的当前项目目录和 AGENTS.md。
2. 读取本文，复述已冻结架构，用一句话确认理解，不重新询问已回答的选择。
3. 盘点本机可用语言、运行时和测试工具。
4. 创建干净的新项目骨架和决策记录。
5. 实现协议 schema、操作 journal 和 fake Agent。
6. 做本地读文件、编辑冲突、权限拒绝的最小测试。
7. 实现一条 loopback 传输，把 fake Agent 与 local-host 连接。
8. 增加真实 WSS、鉴权和会话绑定。
9. 编写 runtime adapter 的输入输出契约测试。
10. 在有 VPS 访问和官方登录后执行 P0 真实验证。
11. 接入真实 MCP 工具桥并完成一个临时项目任务。
12. 写测试报告与后续任务清单，不能把尚未运行的真实测试写成通过。

缺少 VPS 信息时继续完成第 4—9 项，同时询问真正缺失的部署信息。不能把没有凭据解释为整个项目无法开始。

### 26.4 建议交付文件

新 session 开发完成的每个阶段，应更新：

~~~text
README.md                 如何运行当前版本
docs/DECISIONS.md          已决定与未决定事项
docs/COMPATIBILITY.md      实测版本及支持能力
docs/AUTH.md               官方登录维护，不含秘密
docs/PROTOCOL.md           稳定消息契约
docs/RUNBOOK.md            部署、恢复、停止与诊断
docs/TEST-REPORT.md        哪些测试通过，哪些未运行
~~~

### 26.5 可直接复制给新 session 的启动提示

~~~text
请先完整阅读我提供的 PERSONAL_CLAUDE_RELAY_HANDOFF.zh-CN.md，
然后开始实现个人 Claude 中转站，不要只给计划。

已确认的硬约束：
1. 官方 Claude Code 主进程和模型连接必须运行在我的东京 VPS。
2. 使用我自己的 Claude Pro/Max 订阅登录，不默认改为 API Key 计费。
3. 文件、Shell、Git、构建、测试和项目工具在客户端所在的
   Windows/WSL/Linux 环境执行。
4. 本地使用兼容客户端和工具桥接；我接受较大的开发量，
   目标是尽量接近本地原生 Claude Code 的体验。
5. 这是个人自用服务，不做公共账号池、额度销售或多人共享订阅。

架构采用：
本地 TUI + local-host
  <-> 加密双向 bridge
  <-> VPS session supervisor + MCP bridge
  <-> 官方 Claude Code。

New API 仅作网关设计参考，不能用“本地 Claude Code 改 base URL”
或“把项目同步到 VPS 执行”替代已确认架构。
默认优先使用官方 CLI 的公开程序化接口；复原源码用于研究。

从文档 P0/P1 开始。先检查环境，创建代码骨架、协议、操作 journal、
fake Agent 和本地工具测试，再逐步接入真实 CLI。
缺少 VPS 访问或登录时继续做不依赖它的开发，并明确列出缺失信息。
不要输出或记录 OAuth/API/设备 token。
遇到执行结果不明时不要自动重跑副作用命令。

完成每个阶段都提供代码、运行方法、测试结果和明确限制。
不要把 mock 通过写成真实订阅/VPS 联调已经通过。
~~~

## 27. 用户原始需求与澄清记录

本节保留用户原始表述，供新 session 理解动机。引文中的设想不自动覆盖第 0 节最终确认的架构，也不把用户对封号的判断当作研究结论。仅对链接旁的空白做排版整理。

### 27.1 最初的技术讨论请求

> 因为我们知道，claude很容易封号，所以我现在有一个想法：我们现在有一台位于东京的VPS，那么是不是可以创造一个agent工具，大概想法是VPS上一直挂着一个claude code进程，然后我们在本地（比如我的本地windows，WSL 或者其他服务器），然后我们的request通过agent工具转发（可能需要一些协议，流量伪装之类的），经过这台VPS上的claude code进程发送到anthropic的claude服务器，然后接受返回，再由我们这个agent工具发回到本地从而实现在本地使用claude的效果（当然其实请求都是经过VPS的），这样有没有办法让我们的请求好像就是从VPS发出的，这样claude的服务器看到的ip、本机数据等就都是VPS的数据？
>
> 这个想法仅仅是作为技术讨论，我想知道是否可行，如果可行应该怎么做？https://github.com/JackXing875/claude-code 这个仓库及其上游仓库是claude code的agent源代码 你可以看看这个 想想怎么实现我们的需求

### 27.2 对本地执行和原生体验的澄清

> 我希望代码和命令仍然在本地 Windows/WSL 执行，Claude Code 的主进程和模型请求放在 VPS 上。你能详细设计一下这个本地工具桥接方案吗？我的意思就是，用户使用起来的感觉就像是在本地（win or wsl or server）用原生claude code一样，VPS只是流量（请求）/回答）转发器，用户看到的一切都与VPS无关，用户不需要知道VPS的存在。或者你可以理解成中转站？

### 27.3 要求参考 New API 并交接到新 session

> 这样就是类似中转站的实现方式吗？类似newapi？https://github.com/QuantumNous/new-api 你参考一下这个项目。或者如果我理解错了就按你的来。想好了就写一份非常非常详细的文档，描述我们的动机（可以包含我的几段原始prompt）、具体实现思路、需要看的项目、执行步骤大纲等等，我们在一个新的session里，依靠这份文档开始这个个人中转站的创建。

### 27.4 最终认证选择

> Claude Pro／Max 订阅登录

### 27.5 最终架构选择

> 主进程必须在 VPS：本地使用兼容客户端和工具桥接，接受更大的开发量

## 28. 来源清单与证据边界

### 28.1 官方文档

以下为本次核对的主要官方资料；下一次实施应再次确认与实际安装版本相符：

| 编号 | 资料 | 本文使用范围 |
| --- | --- | --- |
| S01 | [Authentication](https://code.claude.com/docs/en/authentication) | 官方登录、凭据优先级和脚本认证 |
| S02 | [Run Claude Code programmatically](https://code.claude.com/docs/en/headless) | -p、结构化输出、恢复与 bare 模式限制 |
| S03 | [CLI reference](https://code.claude.com/docs/en/cli-reference) | 候选 flags 与工具/MCP 控制 |
| S04 | [MCP](https://code.claude.com/docs/en/mcp) | stdio、配置、工具接入 |
| S05 | [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | SDK 与 CLI 的关系和使用边界 |
| S06 | [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools) | 自定义工具与内置工具可见性 |
| S07 | [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions) | canUseTool 与规则并非总执行拦截器 |
| S08 | [User input](https://code.claude.com/docs/en/agent-sdk/user-input) | 用户回答和审批接口参考 |
| S09 | [File checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing) | 原生检查点不能被假定覆盖所有自定义工具副作用 |
| S10 | [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway) | 网关与订阅行为的区别 |
| S11 | [Gateway compatibility](https://code.claude.com/docs/en/llm-gateway-protocol) | 请求头、模型端点、计数回退和协议兼容性 |
| S12 | [Network configuration](https://code.claude.com/docs/en/network-config) | 网络代理是另一种架构，未选作主线 |
| S13 | [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | 官方客户端及凭据使用的适用性边界 |
| S14 | [Data usage](https://code.claude.com/docs/en/data-usage) | 不承诺代码/会话内容从不离开本地 |
| S15 | [Remote Control](https://code.claude.com/docs/en/remote-control) | 官方远程控制不自动等同本地工具桥接 |

SDK TypeScript 巨型参考页面在本次浏览中有读取失败；streaming-input 页面也有获取失败。本文没有把这些失败页面当作已完整阅读的证据。

Firecrawl 插件额度耗尽后，使用网页工具继续读取官方文档；GitHub 文件通过 GitHub 连接器读取。资料获取方式不构成运行验证。

### 28.2 仓库快照

| 仓库 | 固定 commit | 主要用途 |
| --- | --- | --- |
| [QuantumNous/new-api](https://github.com/QuantumNous/new-api/commit/e9d4d6353ce2c11df753d751ba1ad778e2433a88) | e9d4d6353ce2c11df753d751ba1ad778e2433a88 | 模型网关职责与实现参考 |
| [JackXing875/claude-code](https://github.com/JackXing875/claude-code/commit/c57e6ee38437e33dc8f6eb773e2c3d572c188778) | c57e6ee38437e33dc8f6eb773e2c3d572c188778 | 用户提供的复原源码研究 |
| [claude-code-best/claude-code](https://github.com/claude-code-best/claude-code/commit/77a7934e15d69da13879112ed7db695c9ee7a52a) | 77a7934e15d69da13879112ed7db695c9ee7a52a | 上游 RCS 与桥接参考 |

仓库可访问和 README 的功能声明，不代表完整功能已经由我们运行确认。本次没有完整安全审计，也没有构建上述项目。

### 28.3 事实、推断与设计的区分

- “文件中存在某个函数/参数”：静态证据。
- “官方文档描述某行为”：文档证据，需要匹配部署版本。
- “采用这些能力可以搭建桥”：工程推断，需要 P0/P1 验证。
- “operation journal、epoch、协议、模块布局”：本文提出的设计。
- “真实可用、延迟、稳定性”：必须用实现和测试证明，目前未测。

## 29. 关键术语与接手时的快速核对

| 术语 | 本文含义 |
| --- | --- |
| 主进程/Agent runtime | VPS 上运行官方 Claude Code、驱动模型和工具循环的进程 |
| 本地 | bridge 客户端选定的执行环境 |
| 工具桥 | 将 Agent 的工具调用送到本地，并将结果送回的机制 |
| 中转站 | 本项目的用户视角名称；内部是有状态 Agent 服务 |
| 模型网关 | 转发单次模型协议请求的服务，New API 属于这一类 |
| 会话 | 持续对话与其 workspace/runtime 绑定 |
| turn | 一次用户消息驱动的一段 Agent 工作 |
| operation | 一次需要去重和跟踪的具体工具动作 |
| task | 可以跨连接存活的本地进程或长任务 |
| epoch | 防止旧 worker 继续发号施令的代次 |
| UNKNOWN | 副作用结果不确定，需要核查，不能自动当失败重试 |
| 兼容客户端 | 复现主要交互行为的本项目客户端，不是原封不动的官方 TUI |

接手前快速核对：

- 用户已经选了个人 Pro／Max，不要再默认 API Key。
- 用户已经选了主进程 VPS，不要再默认本地 CLI 加代理。
- 项目副作用都应在本地，不能有 VPS 自动执行回退。
- 官方 CLI 优先，复原仓库作为研究参考。
- 先验证真实接口，再扩展 UI 和高级功能。
- 认证、执行权限、操作去重和会话恢复是第一版的基础能力。
- 本文是设计与交接，不是已部署系统的说明书。

## 30. 首轮实施记录（2026-10-23，Asia/Shanghai）

### 30.1 保留的架构与新增取舍

H1—H5 以及“官方 CLI + MCP + 本地最终权限”保持不变。当前目录已初始化独立 TypeScript 项目与本地 Git 仓库，未复制第三方复原源码。具体取舍见 [docs/DECISIONS.md](docs/DECISIONS.md)。

为了先获得可复现证据，本轮将 P0/P1 分为原型闭环和真实订阅验证两部分：

1. 原型使用明确标识的 Fake Agent，通过真实 WS/WSS 驱动本地文件和进程。
2. CLI 与 local-host 暂时同进程；长驻 daemon、完整 TUI、后台任务和 Windows 原生保持后续阶段。
3. 文件工具暂限普通 UTF-8 文件，拒绝 symlink；命令只支持前台 exec，不自动解析 Shell。
4. 官方运行时提供固定版本启动配置、NDJSON 解码和只读 MCP probe，暂不接入普通服务端入口。
5. 用户明确选择先完成原型，稍后再进行官方订阅登录。

### 30.2 已有产物

- apps/relay-server：设备鉴权、session 绑定、单活动 turn、事件与派发记录。
- apps/local-host：本地权限、操作串行化、审批、取消与持久结果。
- apps/bridge-cli：演示、交互式原型、脱敏 doctor、P0 probe、远端网络 smoke。
- apps/mcp-bridge：MCP SDK 工具映射与单工具 stdio probe。
- packages：共享 schema、SQLite journal、文件工具、进程组执行、WebSocket RPC、运行时适配。
- tests：文件/权限、重复投递、丢失结果、崩溃 UNKNOWN、WSS/鉴权、恢复、MCP、运行时合成契约测试。
- README 与 docs 下的认证、协议、运行手册、兼容性和测试报告。

本地完整测试 37/37 通过，生产依赖审计未报告漏洞。VPS Fake Agent → SSH 加密隧道 → 本地 WSL 的读/改/测试闭环已运行通过，项目样例没有部署到 VPS。细节以 [docs/TEST-REPORT.md](docs/TEST-REPORT.md) 为准。

### 30.3 VPS 准备与阶段边界

通过用户指定的 SSH 入口完成连接；已安装固定版本 Node.js 24.14.0 和官方 Claude Code 2.1.267，创建专用非 root 账号 claude-relay。原型程序位于 /opt/personal-relay/prototype。临时网络测试服务与凭据在验收后清理，未安装常驻 systemd 服务。

VPS 约 1 GB RAM，低于官方列出的 4 GB 系统要求。当前只证明安装、版本命令和模拟服务可以运行；没有证明真实模型负载可稳定运行。

**P0 真实验证、P1 真实 Claude 端到端验收以及“第一版可用”均未完成。** 尚待官方登录、受控 MCP 实际调用/配置隔离、Claude 到 supervisor 的会话 IPC、真实流式输入/取消/恢复和资源测量。不能把模拟测试、安装成功或本地已登录状态当作这些验收的替代。

### 30.4 下一轮入口

先阅读 README、docs/TEST-REPORT.md 和 docs/COMPATIBILITY.md。用户准备好后按 docs/AUTH.md 完成 VPS 专用账号的官方登录，再运行只读 P0 probe。根据真实事件核对固定版本的工具清单、认证来源与会话语义，通过后连接真实 MCP IPC，最后执行本地临时项目的真实 Claude 验收。

开源准备保留：独立实现、锁定依赖、测试与 CI 配置、无秘密样例。当前 package 为 private/UNLICENSED，没有创建或推送 GitHub 远程仓库；正式发布前再确定许可证和公开文档范围。




## 31. Claude Tether 开源工程化（2026-10-23）

主仓库为 [JackXing875/claude-tether](https://github.com/JackXing875/claude-tether)，以 GitHub main 内容为起点。用户已加入 GPL-3.0 LICENSE；第 30 节的“无远程仓库 / UNLICENSED”为历史状态，不再适用。

本轮将原型拆为可独立导入的核心模块，并提供统一 `tether` CLI、私有状态默认值、设备管理、类型声明和可安装 tarball。SQLite 内部表由所属模块管理，依赖方向由架构检查约束。TypeScript 固定为与当前 ESLint 类型分析兼容的 6.0.3。

当前用法以 [README](README.md)、[快速开始](docs/QUICKSTART.md)和 CLI `--help` 为准；旧 `dist/apps/*/main.js` 直接启动方式已被统一入口替代。持续测试覆盖源码检查、Linux/Node 24、权限/恢复、独立 CLI 进程，以及仓库外仅生产依赖安装。GitHub CI 是否通过必须核对具体提交，不能仅依据本地结果。

[架构](docs/ARCHITECTURE.md)、[贡献指南](CONTRIBUTING.md)、[测试说明](docs/TESTING.md)、[发布流程](docs/RELEASING.md)与[路线图](docs/ROADMAP.md)承接后续维护。`private: true` 只防止误发布 npm，并不改变 GPL 开源许可。

H1—H5 不变，真实官方订阅链路仍是独立退出条件。工程化和离线 CI 不证明真实 Claude 可用；当前明确要求 `--runtime fake`，不会自动回退或冒充已完成模型联调。官方登录仍由用户本人完成，凭据不进入仓库和 CI。

## 32. 候选官方运行时闭环（离线验证阶段）

在开源基础分支之上补齐 runtime supervisor、独立 MCP stdio worker、每轮私有能力凭据与会话映射。每个工具调用校验完整绑定和 turn，初始化工具集合确认前禁止派发；断开的调用不会自动重连重放。取消或失败后停止 CLI/MCP 进程组、取消本地工具、等待在途结果并清理短期凭据。明确 runtime UUID 保存在私有 SQLite，下一轮使用 `--resume`，异常中断要求先显式恢复 bridge 会话。

验证使用自建替身 CLI、真实 MCP SDK/子进程和真实本地文件/进程。替身主动返回假的订阅状态，仅用于测试启动与协议；没有调用官方模型，也不证明真实账号可用。公开 CLI 继续只启用 fake runtime，待用户官方登录与 P0 完成后再开放真实运行路径。实现与证据边界见 [架构](docs/ARCHITECTURE.md)和[测试说明](docs/TESTING.md)。

## 33. 客户端等待与关闭语义修复

用户继续选择稍后官方登录，本轮只做离线工程检查。检查发现同一 turn 的多个 `waitTurn` 调用会相互覆盖，导致漏收完成或断线结果；三项新增回归测试在旧实现上均复现失败。修复后每个等待者独立计时，关闭客户端立即结束全部等待，重复关闭安全；新增超时参数校验和每个客户端最多 64 个等待者的限制。等待超时只结束该观察者，不取消或重放实际任务。另有回归测试验证容量在超时后正确释放，接口契约见 [架构文档](docs/ARCHITECTURE.md)。真实 Claude 登录、模型联调和日常可用性验收继续保留原来的退出条件。

## 34. 显式会话发现入口

新增 `tether sessions`、JSON 输出及公共客户端 `listSessions`。查询使用已保存且经校验的设备、项目目录身份、generation、执行目标与权限版本，只返回匹配会话的 ID、最近一轮状态、连接状态和未核实操作数量。它不创建会话、不推进 worker epoch、不注册本地工具，也不打开或修改操作 journal；没有旧身份文件时返回空列表，不猜测或重建“最近会话”。实际恢复仍由用户明确选择 ID，并经过原有占用、绑定和结果对账检查。实现复用既有服务器表，不引入数据迁移；旧 relay 不支持新增 RPC 时明确报错。相关网络、CLI 与身份校验测试和操作说明已补充。此入口改善 P2/P3 恢复体验，不替代 UNKNOWN 的人工核实流程或真实 Claude 验收。

## 35. P0 探针验收条件修正

阶段审计发现旧探针的第二轮只要求成功结束，不能据此证明记住了第一轮上下文；标记跨多条流事件时也可能被漏判。现改用每次随机生成的 MCP challenge，并分别校验两轮的指定 UUID、唯一工具清单和标记。第二轮提示不包含答案，工具中的 challenge 已替换；任何重新调用工具、遗忘旧标记或换会话的“成功响应”均不通过恢复检查。探针改在私有父目录下创建和清理独立临时目录，响应 SIGINT/SIGTERM 并收割 CLI/MCP 子进程组，不再静默修改已有父目录权限。离线测试使用专门替身 CLI 和真实 MCP 子进程，覆盖错误成功响应、分片文本、取消与清理；仍不构成真实订阅验证。审计时 VPS 只读诊断为 `logged_in: false`，未发起模型请求。

## 36. 真实 Pro 联调与可启动的 alpha

用户完成官方登录后，在专用非 root 账号中确认 `claude.ai` 认证、固定 CLI 2.1.267、无已知凭据环境覆盖；检查到的 settings 中无 apiKeyHelper、provider 或额外 MCP/hook 配置。两轮 P0 通过新挑战、实际工具调用和指定 UUID 的无工具回忆检查。随后真实官方 Claude 经 MCP/supervisor/relay 修改 WSL 的临时函数并运行本地测试；VPS 无项目文件副本。服务重启后保留原会话，拒绝、冲突、取消、断线清理及原会话对账恢复均已验证。首次断线后的重连出现一次 ECONNRESET；服务保持运行，保留原状态后显式重连通过，没有重放任务。

公开入口新增 `server --runtime claude`；客户端与会话查询可用 `--ssh`，自动管理 OpenSSH 字节通道，以稳定的 SSH 别名和远端端口定位状态。补充专用账号的 systemd 服务模板。普通开发不需手工 SSH 登录或同步项目；首次部署、设备注册与订阅重新授权仍是管理操作。

完整数据、观察范围及未测项目见 [真实测试报告](docs/LIVE-TEST-REPORT.md)。此证据支持受控 alpha，不能推广为长期稳定、Windows 原生、完整 TUI、PTY、后台任务或 hooks/skills 兼容。第一版入口与停止/恢复方法见 [快速开始](docs/QUICKSTART.md)和[运行手册](docs/RUNBOOK.md)。
