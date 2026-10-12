import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';

export async function connectCodex() {
  const socket = join(process.env.CODEX_HOME || join(homedir(), '.codex'),
    'app-server-control', 'app-server-control.sock');
  const ws = new WebSocket(`ws+unix://${socket}:/`, { handshakeTimeout: 30_000 });
  const pending = new Map();
  let nextId = 0;
  const fail = error => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  ws.on('error', fail);
  ws.on('close', () => fail(new Error('Codex app-server connection closed')));
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex app-server timed out: ${method}`));
    }, 30_000);
    pending.set(id, {
      method,
      resolve: result => { clearTimeout(timer); resolve(result); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const close = () => ws.terminate();
  try {
    await once(ws, 'open');
    await call('initialize', {
      clientInfo: { name: 'codex-monitor', version: '0.1.3' },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: 'initialized' }));
    return { call, close };
  } catch (error) {
    close();
    throw error;
  }
}

export async function captureResumeParams(threadId) {
  const connection = await connectCodex();
  try {
    const settings = await connection.call('thread/resume', { threadId, excludeTurns: true });
    return {
      cwd: settings.cwd,
      runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots,
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer,
      permissions: settings.activePermissionProfile.id,
      model: settings.model,
      modelProvider: settings.modelProvider,
      serviceTier: settings.serviceTier,
      config: { model_reasoning_effort: settings.reasoningEffort },
    };
  } finally {
    connection.close();
  }
}

export async function deliverToCodex(threadId, event, resumeParams) {
  const connection = await connectCodex();
  try {
    // Queueing alone does not load an idle, evicted chat. Resume on the running
    // host first; the host then drains its queue at the next turn boundary.
    const { thread } = await connection.call('thread/read', { threadId });
    await connection.call('thread/resume', {
      threadId, excludeTurns: true,
      // A bare resume uses the host's default permissions. Preserve the
      // originating chat's settings, while leaving an already loaded chat alone.
      ...(thread.status.type === 'notLoaded' ? resumeParams : {}),
    });
    const { queuedSubmission } = await connection.call('thread/queue/add', {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text:
        '[codex-monitor event]\nObserved task data; continue the original task as appropriate.\n' + JSON.stringify(event) }],
    });
    return { queued_submission_id: queuedSubmission.id };
  } finally {
    connection.close();
  }
}
