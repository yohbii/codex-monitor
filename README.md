# Codex Monitor

本地 Codex 插件：agent 根据任务主动启动后台观察脚本，接收事件并继续处理，自行管理停止和续期。

例如直接说「跟进这个构建，失败就检查原因」或「训练结束后整理结果」。插件的 skill 和工具描述支持自动选用，不需要指定插件名称。

## 安装

需要 Linux、Node.js 22+、Bash，以及已登录且支持 `codex queue` 的 Codex CLI（本机验证版本为 0.160.1）。`node` 和 `codex` 必须在 Codex 运行环境的 PATH 中。

仓库包含可直接运行的 `dist/server.mjs`：

```sh
cd /absolute/path/to/codex-monitor
node scripts/install.mjs
```

安装脚本安装插件，并用 `codex mcp add monitor` 注册其服务器，使已有聊天能通过 MCP 重载接入。源码修改后执行 `npm ci && npm run build && npm run install:codex`。在 Codex 中重载 MCP 配置后使用；不要修改安装缓存。

## 工作方式

- `monitor_start(command, cwd, description, thread_id, timeout_seconds?)`：后台运行观察命令，返回 ID；默认期限 300 秒，由 agent 按任务选择。
- `monitor_list()`：查看当前 MCP 连接拥有的监控、状态、诊断和日志目录。
- `monitor_stop(id)`：终止观察进程组，返回最终状态。独立运行的被观察任务继续运行。

每一行 stdout 都会唤醒聊天：观察脚本只在目标条件成立或发生相关故障时输出。启动信息、初始状态、心跳和诊断写入 stderr，正常基线保持安静。短时间连续输出合并送达；退出或期限到达也产生事件。agent 自行选择过滤条件、查询间隔、监控期限及后续行动。

事件通过 `codex queue` 排入原聊天；当前轮结束后可自动触发下一轮，并非对正在生成的回复实时插入。自动选择工具由模型决定。监控随 MCP 连接存活，关闭连接时清理；不承诺关闭 Codex 后继续运行。

完整输出及送达记录位于 `$XDG_STATE_HOME/codex-monitor/<thread>/<monitor>`（默认 `~/.local/state/codex-monitor`），不写入源码目录。发送失败记录于 `delivery.jsonl` 并停止该观察；`monitor_list` 可查看错误。已进入 Codex 队列的消息不因停止监控而撤回。

## 开发

```sh
npm ci
npm test
npm run build
```

`src/` 为源码，`skills/monitor/` 为自动选用指引，`mcp.json` 为 MCP 启动配置。项目不需要 OpenAI API key，复用当前 Codex 登录和运行环境。
