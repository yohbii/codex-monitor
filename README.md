<div align="center">

<img src="assets/monitor.svg" alt="Codex Monitor" width="88">

<h1>Codex Monitor</h1>

Let Codex watch in the background and pick up where it left off.

[Install](#install) · [Usage](#usage) · [Tools](#tools)

[![GitHub stars](https://img.shields.io/github/stars/yohbii/codex-monitor?style=for-the-badge&logo=github&label=Stars)](https://github.com/yohbii/codex-monitor/stargazers)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Linux](https://img.shields.io/badge/Linux-133b34?style=for-the-badge&logo=linux&logoColor=white)](#install)

</div>

Codex Monitor gives Codex background monitoring with events that bring it back to the task. Follow a build, wait for a training run to finish, or watch logs and files for changes. When a condition is met, an event returns to the original chat so Codex can take the next step.

Keep working or switch chats while a watch runs. Codex chooses the observation command, check interval, and timeout, and decides when to stop or renew the watch.

## Install

### Ask Codex

Send this message to Codex:

```text
Install Codex Monitor from https://github.com/yohbii/codex-monitor and follow the README to complete setup.
```

Requires **Linux, Bash, Node.js 22+**, and an authenticated, running Codex app-server on the same host. Tested with Codex CLI 0.160.1 and Codex Desktop. The plugin connects to the local app-server control socket under `CODEX_HOME` (default `~/.codex`).

After installation, reload the MCP configuration or restart Codex.

<details>
<summary>Manual install</summary>

Run these commands on the host where Codex runs. For remote SSH sessions, install on the remote host:

```bash
git clone https://github.com/yohbii/codex-monitor.git
cd codex-monitor
node scripts/install.mjs
```

The script adds a local marketplace, installs the plugin, and registers an MCP server named `monitor`. The repository includes a bundled server, so installation does not require downloading npm dependencies.

Both `node` and `codex` must be on the `PATH` available to Codex. The plugin uses your existing Codex login; no separate API key is needed.

</details>

## Usage

Tell Codex what to wait for and what to do next.

**Follow a build**

```text
The build is running in the background and logging to /workspace/app/build.log.
When BUILD_READY appears, check the artifacts in dist/. If it fails, investigate the error logs.
```

**Wait for training to finish**

```text
Follow the current training run. When it finishes, summarize the final metrics and checkpoint paths.
```

**Wait for data**

```text
Wait for /workspace/data/ready.json to appear, then read it and start the data checks.
```

Codex starts a background watch and continues when an event arrives. You can also ask it to “show current monitors” or “stop this watch.”

The included [monitor skill](skills/monitor/SKILL.md) guides Codex to use the tools proactively when a task requires waiting and to handle incoming events. Tool selection remains a model decision based on the task.

## Tools

The plugin exposes three MCP tools:

| Tool | Purpose |
| --- | --- |
| `monitor_start` | Start a background watch and immediately return its ID |
| `monitor_list` | Find watches across reconnects, including status and diagnostics |
| `monitor_stop` | Stop a watch and its child processes |

<details>
<summary>Parameters and events</summary>

`monitor_start` accepts:

| Parameter | Description |
| --- | --- |
| `command` | Bash command that observes the task |
| `cwd` | Absolute working directory for the command |
| `description` | What is being watched and why |
| `thread_id` | Originating chat UUID, obtained by the agent with `printenv CODEX_THREAD_ID` |
| `timeout_seconds` | Optional watch lifetime, chosen by the agent; defaults to 300 seconds |

`monitor_list` accepts an optional `thread_id` to filter by chat; omit it to list watches on this host. `monitor_stop` takes `id`, the monitor ID returned at startup.

The observation script filters logs, queries status, and detects changes. Every stdout line triggers event delivery, so scripts should emit only when a condition is met or a relevant failure occurs. Send startup messages, heartbeats, and diagnostics to stderr. Process exit and timeout also generate events.

Events include the monitor ID, description, working directory, and output. The plugin resumes the original chat through the running app-server before adding the event to its queue, so an unloaded chat can continue. It restores the permissions, workspace, and model settings captured when the watch started. An already loaded chat keeps its current settings. If the chat is busy, events wait until the current turn ends.

</details>

<details>
<summary>Lifecycle and logs</summary>

Each watch runs in an independent worker. Chat unloads, MCP disconnects, and server reloads leave it running, and a reconnected chat can list or stop it. Workers follow the Codex host process that launched the MCP server. When that process exits, its watches stop with status `host_exited`. In remote desktop setups, this is the remote Codex app-server, which can outlive a desktop window. A new host process does not automatically restart stopped watches.

Start the actual build or training job separately. Stopping a watch terminates the observation script and its child processes. Events already queued in Codex are not withdrawn. A timeout ends the current watch; the agent decides whether to renew it based on the original task.

Logs are stored in `~/.local/state/codex-monitor/<thread>/<monitor>/` by default. If `XDG_STATE_HOME` is set, they are stored under its `codex-monitor/` directory instead.

- `stdout.log`, `stderr.log`: output from the observation script.
- `delivery.jsonl`: queue receipts (with submission IDs) and delivery failures. A queue receipt confirms enqueueing, not successful task completion.
- `result.json`: the watch state when its process exits.
- `state.json`: current status, worker PID, and Codex host PID, used across reconnects.

`monitor_list` returns the actual log directory, the stderr tail, and any `delivery_error`. Delivery failures are recorded and stop the watch if it is still running.

</details>

## Development

```bash
npm ci
npm test
npm run build
```

[`src/`](src/) contains the MCP tools and observation process management. [`skills/monitor/`](skills/monitor/) contains the agent instructions. The build output is `dist/server.mjs`.

After making changes, run `npm run install:codex` to reinstall, then reload the MCP configuration.
