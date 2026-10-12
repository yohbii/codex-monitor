import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Watches } from './watches.js';
import { captureResumeParams } from './delivery.js';

const monitors = new Watches({ worker: new URL(import.meta.url.endsWith('.mjs') ? './worker.mjs' : './worker.js', import.meta.url) });
const server = new McpServer({ name: 'codex-monitor', version: '0.1.3' });
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const handle = fn => async args => {
  try { return result(await fn(args)); }
  catch (error) { return { ...result({ error: error.message }), isError: true }; }
};

server.registerTool('monitor_start', {
  description: 'Use when a task needs follow-up after a build, training job, log event, or external condition. Start a watch before ending a turn promising to follow up; returns immediately with its ID. Events wake the originating chat after its current turn. Watches survive MCP disconnection while the Codex host process runs. Choose a filtered observation command and deadline yourself. Get thread_id from CODEX_THREAD_ID using the shell.',
  inputSchema: {
    command: z.string().min(1).describe('Bash observation command. Every stdout line wakes the chat: emit only when the requested condition is met or a relevant failure occurs. Startup messages, baselines, heartbeats, and diagnostics belong on stderr.'),
    cwd: z.string().startsWith('/').describe('Absolute working directory for the observation command.'),
    description: z.string().min(1).describe('What is being watched and why.'),
    thread_id: z.uuid().describe('Originating chat ID, obtained from printenv CODEX_THREAD_ID in the current chat.'),
    timeout_seconds: z.number().positive().max(2147483).optional().describe('Watch lifetime; default 300 seconds. Choose according to the task, and renew when useful.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, handle(async args => monitors.start({ ...args, resume_params: await captureResumeParams(args.thread_id) })));

server.registerTool('monitor_list', {
  description: 'Find existing watches, including those started before a chat reconnected. Pass the current thread_id to inspect this chat before creating a replacement. Events arrive automatically; do not poll this tool to wait.',
  inputSchema: { thread_id: z.uuid().optional().describe('Filter by originating chat. Omit to list watches on this host.') },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, handle(({ thread_id }) => monitors.list(thread_id)));

server.registerTool('monitor_stop', {
  description: 'Stop a watch that is no longer needed. Terminates its observation process group, not an independently running task being observed. Returns its final status.',
  inputSchema: { id: z.string().describe('Monitor ID returned by monitor_start or monitor_list.') },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, handle(({ id }) => monitors.stop(id)));

// Closing a tool connection does not cancel its independently owned watches.
process.stdin.on('end', () => { void server.close(); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void server.close().then(() => process.exit(0)); });
}
await server.connect(new StdioServerTransport());
