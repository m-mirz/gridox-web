import { describe, expect, it } from 'vitest';
import { WorkerClient, type WorkerLike } from './client';
import type { Envelope, Reply, Summary } from './protocol';

const summary: Summary = { files: [], objects: 1, foreign: 0, classes: [], excluded: [] };
const answer = (objects: number) => JSON.stringify({ summary: { ...summary, objects }, kept: false });

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  sent: Envelope[] = [];
  terminated = false;
  postMessage(message: Envelope) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(reply: Reply) {
    this.onmessage?.({ data: reply } as MessageEvent<Reply>);
  }
}

function client() {
  const workers: FakeWorker[] = [];
  const made = new WorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  return { made, workers };
}

describe('WorkerClient', () => {
  it('matches each reply to its request, in any order', async () => {
    const { made, workers } = client();
    const first = made.request({ kind: 'clear' });
    const second = made.request({ kind: 'clear' });
    const [a, b] = workers[0].sent;
    workers[0].reply({ id: b.id, ok: true, json: answer(2) });
    workers[0].reply({ id: a.id, ok: true, json: answer(1) });
    expect((await first).summary.objects).toBe(1);
    expect((await second).summary.objects).toBe(2);
  });

  it('rejects what the worker reports as failed, and keeps the worker', async () => {
    const { made, workers } = client();
    const request = made.request({ kind: 'clear' });
    workers[0].reply({ id: workers[0].sent[0].id, ok: false, error: 'bad' });
    await expect(request).rejects.toThrow('bad');
    expect(workers).toHaveLength(1);
  });

  it('replaces a worker that dies, failing what was asked of it', async () => {
    const { made, workers } = client();
    const request = made.request({ kind: 'clear' });
    workers[0].onerror?.({ message: 'unreachable' } as ErrorEvent);
    await expect(request).rejects.toThrow('unreachable');
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    const next = made.request({ kind: 'clear' });
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, json: answer(1) });
    await expect(next).resolves.toEqual({ summary, kept: false });
  });
});
