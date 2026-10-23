# Bridge 1.0：当前实现子集

外层为有大小上限的 JSON-RPC 2.0，传输为 WSS；开发/SSH 隧道仅允许显式启用的数字回环 WS。HTTP 升级前验证 Authorization: Bearer 设备ID.secret。请求 URL 不接收 query token，浏览器 Origin 当前被拒绝。

| 方法                  | 当前行为                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------- |
| connection.hello      | 版本必须为 1.0；声明设备必须等于已认证设备                                               |
| session.create        | 绑定 device/workspace/generation/execution_target/policy_revision，分配 session 与 epoch |
| session.resume        | 必须明确 session；核对原绑定、排除其他控制连接、查询未决本地结果，再递增 epoch           |
| session.describe      | 当前绑定及未决操作数量                                                                   |
| turn.submit           | 单活动 turn；client_message_id 与 prompt 摘要持久绑定；不重放整轮任务                    |
| turn.cancel           | 本地先取消，远端中止派发；取消不代表回滚既有副作用                                       |
| tool.execute          | 完整绑定、turn_id、operation_id、tool、input；仅本地 host 可执行                         |
| operation.status      | 返回本地持久结果；不存在/仍运行/UNKNOWN 时不假装已完成                                   |
| operation.cancel_turn | 通知本地停止该 turn 的前台操作                                                           |
| event.emit            | 有序 cursor、session_id、turn_id、type、data                                             |
| events.resume         | 返回 cursor 后的有限事件页；保留窗口以外报 CURSOR_EXPIRED                                |

当前没有实现 task 系列、workspace.changed、自动重连或通用 session.close。客户端退出会停止前台本地操作。

操作状态：RECEIVED → WAITING_APPROVAL（需要时）→ RUNNING → SUCCEEDED / FAILED / DENIED / CANCELLED。执行端重启时，无持久终态的记录保守转为 UNKNOWN。操作摘要覆盖全部绑定、turn、tool 和经 schema 校验的 input；同 ID 参数变化返回 OPERATION_CONFLICT。SQLite 无法与任意外部命令构成统一事务。

P1 文件工具：workspace_info、read_file、list_files、search_text、edit_text、write_file。命令工具 run_command 只接受 program、args、cwd、timeout_ms。未知字段被拒绝；远端没有 permission.approved 接口。审批函数只接受本地不可变预览与摘要，不从网络解析可信批准对象。

| 限制      | 当前值                                                       |
| --------- | ------------------------------------------------------------ |
| 单消息    | 1 MiB；禁止 WebSocket 压缩                                   |
| 文件      | 128 KiB UTF-8；完整版本 hash；部分读取明确标记               |
| 命令捕获  | stdout/stderr 合计 64 KiB，超出标记 truncated                |
| 命令时间  | 最长 60 秒；P1 只支持同一进程组内的前台进程                  |
| 审批      | 默认 30 秒，超时 DENIED                                      |
| RPC       | 64 个等待响应、16 个执行中请求；发送缓冲限制 1 MiB           |
| 会话/日志 | 最多 128 会话、10,000 turn、10,000 dispatch、10,000 本地操作 |
| 事件保留  | 每会话 256、服务端总计 512、客户端总计 256；每条至多 256 KiB |
| 心跳      | 15 秒；45 秒无 pong 关闭                                     |

达到操作日志上限时停止接收，不自动删除去重依据。现阶段需要人工审阅和归档，没有完成自动磁盘配额、优先控制通道及长期保留策略。
