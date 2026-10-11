import type { SandboxToolHandler } from '../dispatcher.js';

export const createSaveVersionHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const p = (params ?? {}) as { title?: unknown; description?: unknown };
    if (typeof p.title !== 'string' || p.title.trim().length === 0)
      throw new TypeError('save_version: title must be a non-whitespace string');
    if (p.description !== undefined && typeof p.description !== 'string')
      throw new TypeError('save_version: description must be a string');

    const result =
      p.description === undefined
        ? await figmaCtx.saveVersionHistoryAsync(p.title)
        : await figmaCtx.saveVersionHistoryAsync(p.title, p.description);
    return { ok: true, versionId: result?.id ?? null, fileName: figmaCtx.root.name };
  };
