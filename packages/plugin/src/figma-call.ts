import { getToolBudget } from '@figwright/shared';

/** Advice for an import by key that does not answer: Figma may be holding library resolution back. */
export const LIBRARY_DEFERRAL_ADVICE =
  'Figma may defer library resolution in a background file. ' +
  'Bring the target Figma file to the foreground and retry.';

// Room the tool's budget keeps after a Figma call's deadline, for the handler's other awaits and the
// reply's trip to the UI, so the named error reaches the caller before the UI bridge gives up.
const DEADLINE_MARGIN_MS = 10_000;

/** Deadline for one Figma call inside `tool`'s handler: its UI bridge budget less the margin. */
export const figmaDeadlineFor = (tool: string): number => getToolBudget(tool) - DEADLINE_MARGIN_MS;

/** A Figma call that did not answer within its deadline; `call` names it as `<call>(<target>)`. */
export class FigmaDeadlineError extends Error {
  readonly call: string;

  constructor(message: string, call: string) {
    super(message);
    this.call = call;
  }
}

/**
 * Wait on one Figma call for at most `deadlineMs`. Figma cannot cancel the call, so on expiry this
 * rejects with an error that names the call and says it may still finish; the caller's code after
 * the await never runs, so a late answer changes nothing. In time, its value or rejection passes
 * through unchanged. The race keeps a handler on the call, so a late settle is never unhandled.
 */
export const figmaCallWithin = async <T>(
  call: string,
  target: string,
  deadlineMs: number,
  operation: () => Promise<T>,
  advice?: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const waited =
        `${call}(${target}) did not answer within ${deadlineMs / 1000} s. ` +
        'The call was not cancelled and may still finish in Figma; nothing after it was applied.';
      reject(
        new FigmaDeadlineError(
          advice === undefined ? waited : `${waited} ${advice}`,
          `${call}(${target})`,
        ),
      );
    }, deadlineMs);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

/** Run one Figma boundary without changing its successful value. */
export const figmaCall = async <T>(
  call: string,
  target: string,
  operation: () => Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (cause) {
    const prefix = `${call}(${target}) failed: `;
    if (cause instanceof Error && cause.message.startsWith(prefix)) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${prefix}${message}`, { cause });
  }
};
