import type { StyleResult } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { figmaCallWithin, figmaDeadlineFor, LIBRARY_DEFERRAL_ADVICE } from '../figma-call.js';

export const createImportStyleHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const p = (params ?? {}) as { styleKey?: unknown };
    if (typeof p.styleKey !== 'string' || p.styleKey.length === 0) {
      throw new TypeError('import_style: styleKey must be a non-empty string');
    }

    const key = p.styleKey;
    const style = await figmaCallWithin(
      'importStyleByKeyAsync',
      key,
      figmaDeadlineFor('import_style'),
      () => figmaCtx.importStyleByKeyAsync(key),
      LIBRARY_DEFERRAL_ADVICE,
    );
    const result: StyleResult = { ok: true, styleId: style.id, name: style.name };
    return result;
  };
