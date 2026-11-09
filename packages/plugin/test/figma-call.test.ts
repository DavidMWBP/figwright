import { describe, expect, it, vi } from 'vitest';

import { figmaCall } from '../src/figma-call.js';

describe('Figma boundary attribution', () => {
  it('attributes a synchronous callback rejection without repeating the boundary', async () => {
    const cause = new Error('Attempted to invoke callback with invalid id');
    const read = vi.fn<() => Promise<never>>(() => {
      throw cause;
    });
    await expect(figmaCall('getMainComponentAsync', '1:2', read)).rejects.toMatchObject({
      cause,
      message: 'getMainComponentAsync(1:2) failed: Attempted to invoke callback with invalid id',
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    ['getNodeByIdAsync', '1:2'],
    ['exportAsync', '1:2'],
    ['getVariableByIdAsync', 'V:2'],
    ['loadFontAsync', 'Example Sans Regular'],
    ['setCurrentPageAsync', 'P:2'],
    ['getMainComponentAsync', 'I1:2;3:4'],
    ['PageNode.loadAsync', 'P:2'],
  ])('%s names its target and preserves the rejection', async (call, target) => {
    const cause = new Error('unavailable');
    const error = await figmaCall(call, target, () => Promise.reject(cause)).catch(e => e);
    expect(error.message).toBe(`${call}(${target}) failed: unavailable`);
    expect(error.cause).toBe(cause);
  });

  it('attributes a bare string rejection', async () => {
    const error = await figmaCall('exportAsync', '1:2', () => Promise.reject('unavailable')).catch(
      e => e,
    );
    expect(error.message).toBe('exportAsync(1:2) failed: unavailable');
    expect(error.cause).toBe('unavailable');
  });

  it('does not wrap the same boundary twice', async () => {
    const original = new Error('exportAsync(1:2) failed: unavailable', { cause: 'unavailable' });
    const error = await figmaCall('exportAsync', '1:2', () => Promise.reject(original)).catch(
      e => e,
    );
    expect(error).toBe(original);
  });
});
