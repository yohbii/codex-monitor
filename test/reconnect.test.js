import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Watches } from '../src/watches.js';

const thread_id = '00000000-0000-4000-8000-000000000001';
const server = fileURLToPath(new URL('../src/server.js', import.meta.url));

async function until(fn) {
  for (let i = 0; i < 100; i++) {
    const result = await fn();
    if (result) return result;
    await delay(50);
  }
  throw new Error('Expected monitor state did not arrive');
}

test('native MCP disconnect preserves a quiet watch; reconnect can receive events and stop it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-reconnect-'));
  const root = join(dir, 'codex-monitor');
  const watches = new Watches({ root });
  t.after(async () => {
    for (const state of await watches.list()) await watches.stop(state.id);
    await rm(dir, { recursive: true, force: true });
  });
  // The queue substitute records delivery arguments; no test events reach real chats.
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin/codex'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.DELIVERIES, JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 });
  const env = { ...process.env, XDG_STATE_HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, DELIVERIES: join(dir, 'delivered.jsonl') };
  async function connect() {
    const client = new Client({ name: 'monitor-reconnect-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env }));
    t.after(() => client.close());
    return client;
  }
  async function call(client, name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  }
  const first = await connect();
  const watch = await call(first, 'monitor_start', {
    command: "while [ ! -e ready ]; do sleep 0.05; done; printf 'ready\\n'",
    cwd: dir, description: 'continue after ready', thread_id, timeout_seconds: 10,
  });
  await first.close();
  await delay(150);
  await assert.rejects(readFile(env.DELIVERIES), { code: 'ENOENT' });
  assert.doesNotThrow(() => process.kill(watch.worker_pid, 0));
  const second = await connect();
  const listed = await call(second, 'monitor_list', { thread_id });
  assert.equal(listed[0].id, watch.id);
  assert.equal(listed[0].status, 'running');
  await writeFile(join(dir, 'ready'), 'ready');
  const finished = await until(async () => (await watches.list()).find(s => s.id === watch.id && s.ended_at));
  assert.equal(finished.exit_code, 0);
  await until(async () => {
    try { return (await readFile(env.DELIVERIES, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  });
  const deliveries = (await readFile(env.DELIVERIES, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0][2], thread_id);
  const event = JSON.parse(deliveries[0][4].split('\n').at(-1));
  assert.equal(event.monitor_id, watch.id);
  assert.deepEqual(event.events.filter(e => e.type === 'output').map(e => e.text), ['ready']);

  const job = spawn('sleep', ['30']);
  t.after(() => job.kill());
  const ongoing = await call(second, 'monitor_start', {
    command: `kill -0 ${job.pid}; echo $$ > observer.pid; sleep 30`,
    cwd: dir, description: 'observe separate job', thread_id, timeout_seconds: 30,
  });
  await second.close();
  const third = await connect();
  assert.equal((await call(third, 'monitor_stop', { id: ongoing.id })).status, 'stopped');
  const observer = Number(await readFile(join(dir, 'observer.pid'), 'utf8'));
  assert.throws(() => process.kill(-observer, 0), { code: 'ESRCH' });
  assert.doesNotThrow(() => process.kill(job.pid, 0));
  assert.equal((await readFile(env.DELIVERIES, 'utf8')).trim().split('\n').length, 1);
});

test('exiting the Codex host stops its detached observation worker', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-host-'));
  const moduleUrl = new URL('../src/watches.js', import.meta.url).href;
  const hostScript = join(dir, 'host.mjs');
  await writeFile(hostScript, `import { Watches } from ${JSON.stringify(moduleUrl)};
const watches = new Watches({ root: ${JSON.stringify(dir)}, hostPid: process.pid });
const state = await watches.start(${JSON.stringify({ command: 'echo $$ > observer.pid; sleep 30', cwd: dir, description: 'host lifecycle', thread_id, timeout_seconds: 30 })});
process.send(state);
setInterval(() => {}, 1000);
`);
  const host = fork(hostScript, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] });
  t.after(async () => { host.kill(); await rm(dir, { recursive: true, force: true }); });
  const [state] = await once(host, 'message');
  const exited = once(host, 'exit');
  host.kill();
  await exited;
  const watches = new Watches({ root: dir });
  const stopped = await until(async () => (await watches.list()).find(s => s.id === state.id && s.ended_at));
  assert.equal(stopped.status, 'host_exited');
  const observer = Number(await readFile(join(dir, 'observer.pid'), 'utf8'));
  assert.throws(() => process.kill(-observer, 0), { code: 'ESRCH' });
});
