import { fork } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stateRoot } from './monitor.js';

export class Watches {
  constructor({ root = stateRoot, hostPid = process.ppid, worker = new URL('./worker.js', import.meta.url) } = {}) {
    this.root = root;
    // Codex launches the configured Node MCP server directly. The worker follows
    // that Codex process, rather than the shorter-lived MCP connection.
    this.hostPid = hostPid;
    this.worker = worker;
  }

  async start(params) {
    mkdirSync(this.root, { recursive: true });
    const log = openSync(join(this.root, 'worker.log'), 'a');
    let child;
    try {
      child = fork(this.worker, [], { detached: true, stdio: ['ignore', 'ignore', log, 'ipc'], execArgv: [] });
    } finally { closeSync(log); }
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      const onExit = code => reject(new Error(`Monitor worker exited before startup (code ${code})`));
      child.once('exit', onExit);
      child.once('message', ({ state, error }) => {
        child.removeListener('exit', onExit);
        child.unref();
        if (error) reject(new Error(error));
        else resolve(state);
      });
      child.send({ params, root: this.root, hostPid: this.hostPid });
    });
  }

  async list(threadId) {
    const directories = async path => {
      try { return await readdir(path, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    };
    const states = [];
    for (const thread of await directories(this.root)) {
      if (!thread.isDirectory() || (threadId && thread.name !== threadId)) continue;
      for (const monitor of await directories(join(this.root, thread.name))) {
        if (!monitor.isDirectory()) continue;
        try {
          states.push(JSON.parse(await readFile(join(this.root, thread.name, monitor.name, 'state.json'), 'utf8')));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return states.sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  async stop(id) {
    const state = (await this.list()).find(item => item.id === id);
    if (!state) throw new Error(`Unknown monitor: ${id}`);
    if (state.ended_at) return state;
    try { process.kill(state.worker_pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    const path = join(state.directory, 'state.json');
    for (let i = 0; i < 100; i++) {
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current.ended_at) return current;
      await delay(50);
    }
    throw new Error(`Monitor ${id} has not confirmed stopping; inspect ${path}`);
  }
}
