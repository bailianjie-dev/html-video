import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserContext } from './user-context.js';

export type RequestUserSource = 'header' | 'cookie' | 'external';

export interface RequestContext {
  readonly requestId: string;
  readonly user: Readonly<UserContext>;
  readonly source: RequestUserSource;
}

/**
 * Holds request identity across async work without a process-wide mutable
 * "current user". Each run() call receives an isolated async context.
 */
export class RequestContextStorage {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(context: RequestContext, callback: () => T): T {
    const immutableContext: RequestContext = Object.freeze({
      ...context,
      user: Object.freeze({ ...context.user }),
    });
    return this.storage.run(immutableContext, callback);
  }

  get(): RequestContext | undefined {
    return this.storage.getStore();
  }

  getRequired(): RequestContext {
    const context = this.get();
    if (!context) {
      throw new Error('RequestContext is unavailable outside an authenticated request');
    }
    return context;
  }

  getUser(): Readonly<UserContext> | undefined {
    return this.get()?.user;
  }

  getRequiredUser(): Readonly<UserContext> {
    return this.getRequired().user;
  }
}
