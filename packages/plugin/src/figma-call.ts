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
