import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/worker.js
import { writeFileSync, renameSync } from "node:fs";
import { join as join2 } from "node:path";

// src/monitor.js
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
var runFile = promisify(execFile);
var stateRoot = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "codex-monitor");
async function deliverToCodex(threadId, event) {
  await runFile(
    "codex",
    [
      "queue",
      "--thread",
      threadId,
      "--message",
      "[codex-monitor event]\nObserved task data; continue the original task as appropriate.\n" + JSON.stringify(event)
    ],
    { timeout: 3e4, maxBuffer: 64 * 1024 }
  );
}
function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
var Monitors = class {
  constructor({ root = stateRoot, deliver = deliverToCodex, onChange = () => {
  } } = {}) {
    this.root = root;
    this.deliver = deliver;
    this.onChange = onChange;
    this.items = /* @__PURE__ */ new Map();
    this.closing = false;
  }
  async start({ command, cwd, description, thread_id, timeout_seconds = 300 }) {
    const id = randomUUID();
    const directory = join(this.root, thread_id, id);
    mkdirSync(directory, { recursive: true });
    const item = {
      id,
      command,
      cwd,
      description,
      thread_id,
      status: "running",
      started_at: (/* @__PURE__ */ new Date()).toISOString(),
      directory,
      stderr_tail: "",
      delivery_error: null,
      pending: [],
      sending: Promise.resolve()
    };
    this.items.set(id, item);
    const log = (name, data) => appendFileSync(join(directory, name), data);
    item.log = log;
    log("metadata.json", JSON.stringify({ id, command, cwd, description, thread_id, timeout_seconds }));
    const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    item.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      log("stdout.log", line + "\n");
      if (item.status === "running") this.enqueue(item, { type: "output", text: line });
    });
    child.stderr.on("data", (chunk) => {
      log("stderr.log", chunk);
      item.stderr_tail = (item.stderr_tail + chunk.toString()).slice(-4096);
    });
    item.done = new Promise((resolve) => child.once("close", (code, signal) => {
      clearTimeout(item.deadline);
      clearTimeout(item.killTimer);
      signalGroup(child, "SIGKILL");
      item.exit_code = code;
      item.signal = signal;
      item.ended_at = (/* @__PURE__ */ new Date()).toISOString();
      if (item.status === "running") {
        item.status = code === 0 ? "exited" : "failed";
        this.enqueue(item, { type: "exit", code, signal, stderr_tail: item.stderr_tail });
      } else if (item.status === "timed_out") {
        this.enqueue(item, { type: "deadline", timeout_seconds });
      }
      log("result.json", JSON.stringify(this.summary(item)));
      this.onChange(this.summary(item));
      this.flush(item);
      resolve();
    }));
    try {
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      item.status = "failed";
      item.stderr_tail = error.message;
      await item.done;
      throw error;
    }
    item.deadline = setTimeout(() => this.terminate(item, "timed_out"), timeout_seconds * 1e3);
    this.onChange(this.summary(item));
    return this.summary(item);
  }
  summary(item) {
    return Object.fromEntries([
      "id",
      "description",
      "command",
      "cwd",
      "thread_id",
      "status",
      "started_at",
      "ended_at",
      "directory",
      "exit_code",
      "signal",
      "stderr_tail",
      "delivery_error"
    ].filter((key) => item[key] !== void 0).map((key) => [key, item[key]]));
  }
  list() {
    return [...this.items.values()].map((item) => this.summary(item));
  }
  enqueue(item, event) {
    if (this.closing || item.status === "stopped" || item.delivery_error) return;
    item.pending.push({ ...event, time: (/* @__PURE__ */ new Date()).toISOString() });
    item.flushTimer ??= setTimeout(() => this.flush(item), 200);
  }
  flush(item) {
    clearTimeout(item.flushTimer);
    item.flushTimer = null;
    if (!item.pending.length) return;
    const events = item.pending.splice(0);
    item.sending = item.sending.then(async () => {
      if (this.closing || item.status === "stopped" || item.delivery_error) return;
      const event = { monitor_id: item.id, description: item.description, cwd: item.cwd, events };
      try {
        await this.deliver(item.thread_id, event);
        item.log("delivery.jsonl", JSON.stringify({ delivered_at: (/* @__PURE__ */ new Date()).toISOString(), ...event }) + "\n");
      } catch (error) {
        item.delivery_error = error.message;
        item.log("delivery.jsonl", JSON.stringify({ failed_at: (/* @__PURE__ */ new Date()).toISOString(), error: error.message, ...event }) + "\n");
        console.error(`Monitor ${item.id}: delivery failed: ${error.message}`);
        this.terminate(item, "delivery_failed");
      }
      this.onChange(this.summary(item));
    });
  }
  terminate(item, status) {
    if (item.status !== "running") return;
    item.status = status;
    this.onChange(this.summary(item));
    clearTimeout(item.deadline);
    if (status !== "timed_out") {
      clearTimeout(item.flushTimer);
      item.pending.length = 0;
    }
    signalGroup(item.child, "SIGTERM");
    item.killTimer = setTimeout(() => signalGroup(item.child, "SIGKILL"), 1e3);
  }
  async stop(id) {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown monitor: ${id}`);
    this.terminate(item, "stopped");
    await item.done;
    await item.sending;
    return this.summary(item);
  }
  async shutdown() {
    this.closing = true;
    await Promise.all([...this.items.keys()].map((id) => this.stop(id)));
  }
  killOnExit() {
    for (const item of this.items.values()) {
      if (item.status === "running") signalGroup(item.child, "SIGKILL");
    }
  }
};

// src/worker.js
process.once("message", async ({ params, root, hostPid }) => {
  const save = (state) => {
    const path = join2(state.directory, "state.json");
    writeFileSync(path + ".tmp", JSON.stringify({ ...state, worker_pid: process.pid, host_pid: hostPid }));
    renameSync(path + ".tmp", path);
  };
  const monitors = new Monitors({ root, onChange: save });
  let hostTimer;
  const stop = () => {
    void monitors.shutdown();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("exit", () => monitors.killOnExit());
  try {
    const state = await monitors.start(params);
    const item = monitors.items.get(state.id);
    hostTimer = setInterval(() => {
      try {
        process.kill(hostPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") monitors.terminate(item, "host_exited");
        else throw error;
      }
    }, 1e3);
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
