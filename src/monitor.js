import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { deliverToCodex } from './delivery.js';

export const stateRoot = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'codex-monitor');

function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export class Monitors {
  constructor({ root = stateRoot, deliver = deliverToCodex, onChange = () => {} } = {}) {
    this.root = root;
    this.deliver = deliver;
    this.onChange = onChange;
    this.items = new Map();
    this.closing = false;
  }

  async start({ command, cwd, description, thread_id, timeout_seconds = 300, resume_params }) {
    const id = randomUUID();
    const directory = join(this.root, thread_id, id);
    mkdirSync(directory, { recursive: true });
    const item = {
      id, command, cwd, description, thread_id, resume_params, status: 'running',
      started_at: new Date().toISOString(), directory,
      stderr_tail: '', delivery_error: null, pending: [], sending: Promise.resolve(),
    };
    this.items.set(id, item);
    const log = (name, data) => appendFileSync(join(directory, name), data);
    item.log = log;
    log('metadata.json', JSON.stringify({ id, command, cwd, description, thread_id, timeout_seconds, resume_params }));
    const child = spawn('bash', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    item.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      log('stdout.log', line + '\n');
      if (item.status === 'running') this.enqueue(item, { type: 'output', text: line });
    });
    child.stderr.on('data', chunk => {
      log('stderr.log', chunk);
      item.stderr_tail = (item.stderr_tail + chunk.toString()).slice(-4096);
    });
    item.done = new Promise(resolve => child.once('close', (code, signal) => {
      clearTimeout(item.deadline);
      clearTimeout(item.killTimer);
      // A watcher may have background children even after its shell exits.
      signalGroup(child, 'SIGKILL');
      item.exit_code = code;
      item.signal = signal;
      item.ended_at = new Date().toISOString();
      if (item.status === 'running') {
        item.status = code === 0 ? 'exited' : 'failed';
        this.enqueue(item, { type: 'exit', code, signal, stderr_tail: item.stderr_tail });
      } else if (item.status === 'timed_out') {
        this.enqueue(item, { type: 'deadline', timeout_seconds });
      }
      log('result.json', JSON.stringify(this.summary(item)));
      this.onChange(this.summary(item));
      this.flush(item);
      resolve();
    }));
    // An invalid cwd or missing executable must fail the start call immediately.
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      item.status = 'failed';
      item.stderr_tail = error.message;
      await item.done;
      throw error;
    }
    item.deadline = setTimeout(() => this.terminate(item, 'timed_out'), timeout_seconds * 1000);
    this.onChange(this.summary(item));
    return this.summary(item);
  }

  summary(item) {
    return Object.fromEntries(['id', 'description', 'command', 'cwd', 'thread_id', 'status',
      'started_at', 'ended_at', 'directory', 'exit_code', 'signal', 'stderr_tail', 'delivery_error']
      .filter(key => item[key] !== undefined).map(key => [key, item[key]]));
  }

  list() { return [...this.items.values()].map(item => this.summary(item)); }

  enqueue(item, event) {
    if (this.closing || item.status === 'stopped' || item.delivery_error) return;
    item.pending.push({ ...event, time: new Date().toISOString() });
    item.flushTimer ??= setTimeout(() => this.flush(item), 200);
  }

  flush(item) {
    clearTimeout(item.flushTimer);
    item.flushTimer = null;
    if (!item.pending.length) return;
    const events = item.pending.splice(0);
    item.sending = item.sending.then(async () => {
      if (this.closing || item.status === 'stopped' || item.delivery_error) return;
      const event = { monitor_id: item.id, description: item.description, cwd: item.cwd, events };
      try {
        const receipt = await this.deliver(item.thread_id, event, item.resume_params);
        item.log('delivery.jsonl', JSON.stringify({ queued_at: new Date().toISOString(), ...receipt, ...event }) + '\n');
      } catch (error) {
        item.delivery_error = error.message;
        item.log('delivery.jsonl', JSON.stringify({ failed_at: new Date().toISOString(), error: error.message, ...event }) + '\n');
        console.error(`Monitor ${item.id}: delivery failed: ${error.message}`);
        this.terminate(item, 'delivery_failed');
      }
      this.onChange(this.summary(item));
    });
  }

  terminate(item, status) {
    if (item.status !== 'running') return;
    item.status = status;
    this.onChange(this.summary(item));
    clearTimeout(item.deadline);
    if (status !== 'timed_out') {
      clearTimeout(item.flushTimer);
      item.pending.length = 0;
    }
    signalGroup(item.child, 'SIGTERM');
    item.killTimer = setTimeout(() => signalGroup(item.child, 'SIGKILL'), 1000);
  }

  async stop(id) {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown monitor: ${id}`);
    this.terminate(item, 'stopped');
    await item.done;
    await item.sending;
    return this.summary(item);
  }

  async shutdown() {
    this.closing = true;
    await Promise.all([...this.items.keys()].map(id => this.stop(id)));
  }

  killOnExit() {
    for (const item of this.items.values()) {
      if (item.status === 'running') signalGroup(item.child, 'SIGKILL');
    }
  }
}
