import type { VariableResult } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { figmaCallWithin, figmaDeadlineFor, LIBRARY_DEFERRAL_ADVICE } from '../figma-call.js';

export const createImportVariableHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const p = (params ?? {}) as { variableKey?: unknown };
    if (typeof p.variableKey !== 'string' || p.variableKey.length === 0) {
      throw new TypeError('import_variable: variableKey must be a non-empty string');
    }

    // Figma owns publishing/access checks and the target-file id. Never construct an id from
    // the key or a source-library id, nor replace the library reference with a local copy.
    const key = p.variableKey;
    const variable = await figmaCallWithin(
      'importVariableByKeyAsync',
      key,
      figmaDeadlineFor('import_variable'),
      () => figmaCtx.variables.importVariableByKeyAsync(key),
      LIBRARY_DEFERRAL_ADVICE,
    );
    const result: VariableResult = { ok: true, variableId: variable.id, name: variable.name };
    return result;
  };
