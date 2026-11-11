/** The reason a write the queue gave up on carries: the error its caller was already sent. */
export class WriteAbandonedError extends Error {}

/**
 * One running write's abandoned flag. The dispatcher creates one per write and passes it in the
 * handler context; once the write queue gives up on the write it calls `abandon`, after which the
 * write must change nothing more in the document.
 */
export class WriteSignal {
  reason: WriteAbandonedError | undefined;
  private readonly calls = new Set<{ call: string }>();
  private readonly listeners: ((reason: WriteAbandonedError) => void)[] = [];

  get abandoned(): boolean {
    return this.reason !== undefined;
  }

  /** The Figma calls this write is waiting on right now, for the abandonment error. */
  waitingOn(): string[] {
    return [...this.calls].map(entry => entry.call);
  }

  abandon(reason: WriteAbandonedError): void {
    this.reason = reason;
    for (const listener of this.listeners) listener(reason);
  }

  onAbandon(listener: (reason: WriteAbandonedError) => void): void {
    this.listeners.push(listener);
  }

  throwIfAbandoned(): void {
    if (this.reason !== undefined) throw this.reason;
  }

  /**
   * Wait on one Figma call. Once the write is abandoned the returned promise never settles, so no
   * code after the caller's await runs — not even a catch that would carry on and mutate.
   */
  track<T>(call: string, promise: Promise<T>): Promise<T> {
    const entry = { call };
    this.calls.add(entry);
    const settle = (answer: () => void): void => {
      this.calls.delete(entry);
      if (!this.abandoned) answer();
    };
    return new Promise<T>((resolve, reject) => {
      promise.then(
        value => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }
}

const signals = new WeakMap<typeof figma, WriteSignal>();

/** Stop a handler at an await on something other than a Figma API call (a node's own method). */
export const throwIfAbandoned = (figmaCtx: typeof figma): void => {
  signals.get(figmaCtx)?.throwIfAbandoned();
};

export const attachWriteSignal = (figmaCtx: typeof figma, signal: WriteSignal): void => {
  signals.set(figmaCtx, signal);
};

// Figma API namespaces whose async methods write handlers await.
const NAMESPACES: ReadonlySet<PropertyKey> = new Set(['variables', 'annotations']);

const targetOf = (arg: unknown): string => {
  if (typeof arg === 'string') return arg;
  const id = (arg as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : '';
};

const guard = (api: object, path: string, signal: WriteSignal): object =>
  new Proxy(
    {},
    {
      get: (_, prop) => {
        const value: unknown = Reflect.get(api, prop);
        if (NAMESPACES.has(prop) && typeof value === 'object' && value !== null)
          return guard(value, `${path}.${String(prop)}`, signal);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          signal.throwIfAbandoned();
          const out: unknown = Reflect.apply(value, api, args);
          return out instanceof Promise
            ? signal.track(`${path}.${String(prop)}(${targetOf(args[0])})`, out)
            : out;
        };
      },
      set: (_, prop, value) => Reflect.set(api, prop, value),
      has: (_, prop) => Reflect.has(api, prop),
    },
  );

/**
 * The Figma API one write handler receives: identical to `figmaCtx`, except that no call starts
 * once the write is abandoned and no awaited call answers it afterwards. Guarding here, where the
 * handler map is built, stops every handler and helper at its next Figma await without touching
 * their call sites; awaits on a node's own async methods need an explicit `throwIfAbandoned`.
 */
export const withAbandonGuard = (figmaCtx: typeof figma, signal: WriteSignal): typeof figma =>
  guard(figmaCtx, 'figma', signal) as typeof figma;
