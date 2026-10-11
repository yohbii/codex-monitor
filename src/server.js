import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Monitors } from './monitor.js';

const monitors = new Monitors();
const server = new McpServer({ name: 'codex-monitor', version: '0.1.1' });
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const handle = fn => async args => {
  try { return result(await fn(args)); }
  catch (error) { return { ...result({ error: error.message }), isError: true }; }
};

server.registerTool('monitor_start', {
  description: 'Proactively watch a long-running task, log, build, or external condition in the background when the current task needs it. Returns immediately. Stdout lines and process exit are delivered to the originating Codex chat, waking the agent after its turn ends. Choose a filtered observation command and deadline yourself; continue other work instead of polling. Get thread_id from CODEX_THREAD_ID using the shell.',
  inputSchema: {
    command: z.string().min(1).describe('Bash observation command. Every stdout line wakes the chat: emit only when the requested condition is met or a relevant failure occurs. Startup messages, baselines, heartbeats, and diagnostics belong on stderr.'),
    cwd: z.string().startsWith('/').describe('Absolute working directory for the observation command.'),
    description: z.string().min(1).describe('What is being watched and why.'),
    thread_id: z.uuid().describe('Originating chat ID, obtained from printenv CODEX_THREAD_ID in the current chat.'),
    timeout_seconds: z.number().positive().max(2147483).optional().describe('Watch lifetime; default 300 seconds. Choose according to the task, and renew when useful.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, handle(args => monitors.start(args)));

server.registerTool('monitor_list', {
  description: 'Inspect watches owned by this MCP connection, their status, diagnostic tails, and log paths. Events arrive automatically; do not repeatedly call this to wait.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, handle(() => monitors.list()));

server.registerTool('monitor_stop', {
  description: 'Stop a watch that is no longer needed. Terminates its observation process group, not an independently running task being observed. Returns its final status.',
  inputSchema: { id: z.string().describe('Monitor ID returned by monitor_start or monitor_list.') },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, handle(({ id }) => monitors.stop(id)));

let shuttingDown;
function shutdown() {
  shuttingDown ??= monitors.shutdown().then(() => server.close());
  return shuttingDown;
}
server.server.onclose = () => { void shutdown(); };
process.stdin.on('end', () => { void shutdown(); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void shutdown().then(() => process.exit(0)); });
}
process.on('exit', () => monitors.killOnExit());
await server.connect(new StdioServerTransport());
