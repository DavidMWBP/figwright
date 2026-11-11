import type { SandboxToolHandler } from '../dispatcher.js';
import { figmaCallWithin, figmaDeadlineFor } from '../figma-call.js';

export const createSaveVersionHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const p = (params ?? {}) as { title?: unknown; description?: unknown };
    if (typeof p.title !== 'string' || p.title.trim().length === 0)
      throw new TypeError('save_version: title must be a non-whitespace string');
    if (p.description !== undefined && typeof p.description !== 'string')
      throw new TypeError('save_version: description must be a string');

    const title = p.title;
    const description = p.description;
    const result = await figmaCallWithin(
      'saveVersionHistoryAsync',
      JSON.stringify(title),
      figmaDeadlineFor('save_version'),
      () =>
        description === undefined
          ? figmaCtx.saveVersionHistoryAsync(title)
          : figmaCtx.saveVersionHistoryAsync(title, description),
    );
    return { ok: true, versionId: result?.id ?? null, fileName: figmaCtx.root.name };
  };
