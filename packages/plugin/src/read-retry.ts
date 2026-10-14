const CONNECTION_ERROR =
  'Unable to establish connection to Figma after 10 seconds. Please check your internet connection.';
const RETRY_PAUSE_MS = 250;
const RETRY_CAP = 3;

export interface ReadRetryState {
  used: number;
  enabled: boolean;
  stopAt?: number;
}

// Each registry invocation owns a separate proxy and allowance, including parallel invocations.
const states = new WeakMap<typeof figma, ReadRetryState>();

export const attachReadRetry = (figmaCtx: typeof figma, state: ReadRetryState): void => {
  states.set(figmaCtx, state);
};

export const getReadRetryState = (figmaCtx: typeof figma): ReadRetryState | undefined =>
  states.get(figmaCtx);

export const retryRead = async <T>(figmaCtx: typeof figma, read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof TypeError || message !== CONNECTION_ERROR) throw cause;
    const state = states.get(figmaCtx) ?? { used: 0, enabled: true };
    if (!state.enabled) throw cause;
    if (state.used >= RETRY_CAP) {
      throw new Error(`${message} Retry cap reached (3 per tool call).`, { cause });
    }
    // A retry may spend another 10s inside Figma. Do not start one into the unwind reserve.
    if (state.stopAt !== undefined && Date.now() + RETRY_PAUSE_MS + 10_000 >= state.stopAt) {
      throw cause;
    }
    state.used += 1;
    await new Promise<void>(resolve => setTimeout(resolve, RETRY_PAUSE_MS));
    if (state.stopAt !== undefined && Date.now() + 10_000 >= state.stopAt) throw cause;
    try {
      return await read();
    } catch (second) {
      const detail = second instanceof Error ? second.message : String(second);
      throw new Error(
        `${detail} Read failed twice.${state.used >= RETRY_CAP ? ' Retry cap reached (3 per tool call).' : ''}`,
        { cause: second },
      );
    }
  }
};
