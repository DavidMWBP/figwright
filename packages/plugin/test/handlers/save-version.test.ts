import { describe, expect, it, vi } from 'vitest';

import { createSandboxHandlers } from '../../src/handlers/registry.js';

const setup = () => {
  const saveVersionHistoryAsync = vi
    .fn<typeof figma.saveVersionHistoryAsync>()
    .mockResolvedValue({ id: 'version-1' });
  const figmaCtx = {
    root: { name: 'Design file' },
    saveVersionHistoryAsync,
  } as unknown as typeof figma;
  const handler = createSandboxHandlers(figmaCtx).save_version;
  expect(handler, 'save_version must be registered').toBeTypeOf('function');
  return { handler: handler!, saveVersionHistoryAsync };
};

describe('save_version handler', () => {
  it('passes a title and description and returns the version and file name', async () => {
    const { handler, saveVersionHistoryAsync } = setup();
    const result = await handler({ title: 'Before edits', description: 'Restore point' });
    expect(saveVersionHistoryAsync.mock.calls).toEqual([['Before edits', 'Restore point']]);
    expect(result).toEqual({ ok: true, versionId: 'version-1', fileName: 'Design file' });
  });

  it('omits the description argument when it was not given', async () => {
    const { handler, saveVersionHistoryAsync } = setup();
    await handler({ title: ' Before edits ' });
    expect(saveVersionHistoryAsync.mock.calls).toEqual([[' Before edits ']]);
  });

  it.each(['', ' \t\n', undefined, 42])(
    'refuses invalid title %j before calling Figma',
    async title => {
      const { handler, saveVersionHistoryAsync } = setup();
      await expect(handler({ title })).rejects.toThrow(
        new TypeError('save_version: title must be a non-whitespace string'),
      );
      expect(saveVersionHistoryAsync).not.toHaveBeenCalled();
    },
  );

  it('refuses a non-string description before calling Figma', async () => {
    const { handler, saveVersionHistoryAsync } = setup();
    await expect(handler({ title: 'Before edits', description: 42 })).rejects.toThrow(TypeError);
    expect(saveVersionHistoryAsync).not.toHaveBeenCalled();
  });

  it('returns a null versionId when Figma returns null', async () => {
    const { handler, saveVersionHistoryAsync } = setup();
    saveVersionHistoryAsync.mockResolvedValue(null);
    await expect(handler({ title: 'Before edits' })).resolves.toEqual({
      ok: true,
      versionId: null,
      fileName: 'Design file',
    });
  });

  it('propagates the original Figma rejection', async () => {
    const { handler, saveVersionHistoryAsync } = setup();
    const error = new Error('View-only file');
    saveVersionHistoryAsync.mockRejectedValue(error);
    await expect(handler({ title: 'Before edits' })).rejects.toBe(error);
  });
});
