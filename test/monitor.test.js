import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Monitors } from '../src/monitor.js';

const thread_id = '00000000-0000-4000-8000-000000000001';
async function setup(t, deliver) {
  const root = await mkdtemp(join(tmpdir(), 'codex-monitor-test-'));
  const deliveries = [];
  const monitors = new Monitors({ root, deliver: deliver || (async (thread, event) => deliveries.push({ thread, event })) });
  t.after(async () => { await monitors.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { monitors, deliveries, root };
}
async function finish(monitors, id) {
  const item = monitors.items.get(id);
  await item.done;
  await item.sending;
}

test('stdout lines and failed exit reach the originating thread; stderr remains diagnostic', async t => {
  const { monitors, deliveries, root } = await setup(t);
  const watch = await monitors.start({ command: "printf 'first\\npartial'; sleep 0.02; printf ' line\\n'; printf 'failure detail' >&2; exit 7", cwd: root, description: 'build status', thread_id });
  await finish(monitors, watch.id);
  assert.equal(deliveries[0].thread, thread_id);
  const events = deliveries.flatMap(d => d.event.events);
  assert.deepEqual(events.filter(e => e.type === 'output').map(e => e.text), ['first', 'partial line']);
  assert.equal(events.at(-1).code, 7);
  assert.equal(events.at(-1).stderr_tail, 'failure detail');
  assert.equal(monitors.list()[0].status, 'failed');
});

test('silent watches stay quiet until their deadline; stop leaves the observed job alive', async t => {
  const { monitors, deliveries, root } = await setup(t);
  const job = spawn('sleep', ['30']);
  t.after(() => job.kill());
  const watch = await monitors.start({ command: `kill -0 ${job.pid}; sleep 30`, cwd: root, description: 'observe independent job', thread_id });
  await delay(250);
  assert.equal(deliveries.length, 0);
  const watcherPid = monitors.items.get(watch.id).child.pid;
  assert.equal((await monitors.stop(watch.id)).status, 'stopped');
  assert.doesNotThrow(() => process.kill(job.pid, 0));
  assert.throws(() => process.kill(-watcherPid, 0), { code: 'ESRCH' });
  assert.equal(deliveries.length, 0);
  const deadline = await monitors.start({ command: 'sleep 30', cwd: root, description: 'deadline', thread_id, timeout_seconds: 0.05 });
  await finish(monitors, deadline.id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].event.events[0].type, 'deadline');
});

test('delivery failure is recorded and stops observation; invalid cwd fails start', async t => {
  const { monitors, root } = await setup(t, async () => { throw new Error('queue unavailable'); });
  const watch = await monitors.start({ command: "printf 'changed\\n'; sleep 30", cwd: root, description: 'delivery failure', thread_id });
  await finish(monitors, watch.id);
  const state = monitors.list()[0];
  assert.equal(state.status, 'delivery_failed');
  assert.equal(state.delivery_error, 'queue unavailable');
  assert.match(await readFile(join(state.directory, 'delivery.jsonl'), 'utf8'), /queue unavailable/);
  await assert.rejects(monitors.start({ command: 'true', cwd: join(root, 'absent'), description: 'invalid cwd', thread_id }), /ENOENT/);
});

test('shutting down the worker cleans up watchers without notifications', async t => {
  const { monitors, deliveries, root } = await setup(t);
  const watch = await monitors.start({ command: 'sleep 30', cwd: root, description: 'shutdown', thread_id });
  const pid = monitors.items.get(watch.id).child.pid;
  await monitors.shutdown();
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  assert.equal(deliveries.length, 0);
});
