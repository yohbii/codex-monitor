import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Monitors } from './monitor.js';

// One worker owns one watch. MCP clients can disconnect without ending it.
process.once('message', async ({ params, root, hostPid }) => {
  const save = state => {
    const path = join(state.directory, 'state.json');
    writeFileSync(path + '.tmp', JSON.stringify({ ...state, worker_pid: process.pid, host_pid: hostPid }));
    renameSync(path + '.tmp', path);
  };
  const monitors = new Monitors({ root, onChange: save });
  let hostTimer;
  const stop = () => { void monitors.shutdown(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('exit', () => monitors.killOnExit());
  try {
    const state = await monitors.start(params);
    const item = monitors.items.get(state.id);
    hostTimer = setInterval(() => {
      try { process.kill(hostPid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') monitors.terminate(item, 'host_exited');
        else throw error;
      }
    }, 1000);
    process.send({ state: { ...state, worker_pid: process.pid, host_pid: hostPid } });
    process.disconnect();
    await item.done;
    await item.sending;
    save(monitors.summary(item));
  } catch (error) {
    if (process.connected) {
      process.send({ error: error.message });
      process.disconnect();
    } else console.error(error);
    await monitors.shutdown();
    process.exitCode = 1;
  } finally {
    clearInterval(hostTimer);
  }
});
