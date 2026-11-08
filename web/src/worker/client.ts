import type { Envelope, Reply, Request, Summary } from './protocol';

/** The part of a Worker this uses, so that tests can stand in for one. */
export interface WorkerLike {
  onmessage: ((event: MessageEvent<Reply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: Envelope): void;
  terminate(): void;
}

type Pending = { resolve: (summary: Summary) => void; reject: (error: Error) => void };

/**
 * Requests to the worker, as promises. A panic in the wasm kills the instance and everything it
 * held, so the worker is replaced and what was asked of it fails, and the page starts again from its
 * files. Cancelling, later, will be the same thing on purpose.
 */
export class WorkerClient {
  private worker: WorkerLike;
  private pending = new Map<number, Pending>();
  private next = 0;

  constructor(private readonly start: () => WorkerLike) {
    this.worker = this.launch();
  }

  request(request: Request): Promise<Summary> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, request });
    });
  }

  private launch(): WorkerLike {
    const worker = this.start();
    worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.summary);
      else pending.reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      const failed = [...this.pending.values()];
      this.pending.clear();
      this.worker = this.launch();
      for (const { reject } of failed) reject(new Error(event.message || 'The worker stopped'));
    };
    return worker;
  }
}
