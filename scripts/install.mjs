import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = args => execFileSync('codex', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
run(['plugin', 'marketplace', 'add', root, '--json']);
const installed = JSON.parse(run(['plugin', 'add', 'codex-monitor@codex-monitor', '--json']));
// Existing chats reload global MCP configuration, but not newly installed plugin servers.
process.stdout.write(run(['mcp', 'add', 'monitor', '--', process.execPath, join(installed.installedPath, 'dist/server.mjs')]));
console.log(`Installed ${installed.pluginId} ${installed.version}`);
