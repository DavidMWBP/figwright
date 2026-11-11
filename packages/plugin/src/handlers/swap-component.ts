import type { MutateResult } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { figmaCallWithin, figmaDeadlineFor, LIBRARY_DEFERRAL_ADVICE } from '../figma-call.js';

/**
 * Swap an instance's main component. Provide a published `componentKey` (imported via the API) or a
 * local `componentId`. Returns the (unchanged) instance id.
 */
export const createSwapComponentHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const p = (params ?? {}) as {
      instanceId?: unknown;
      componentId?: unknown;
      componentKey?: unknown;
    };
    if (typeof p.instanceId !== 'string') {
      throw new TypeError('swap_component: instanceId must be a string');
    }
    if (typeof p.componentId !== 'string' && typeof p.componentKey !== 'string') {
      throw new TypeError('swap_component: provide componentId or componentKey');
    }

    const instance = await figmaCtx.getNodeByIdAsync(p.instanceId);
    if (instance === null || instance.type !== 'INSTANCE') {
      throw new Error(`swap_component: node ${p.instanceId} is not an INSTANCE`);
    }

    let component: ComponentNode;
    if (typeof p.componentKey === 'string') {
      const key = p.componentKey;
      component = await figmaCallWithin(
        'importComponentByKeyAsync',
        key,
        figmaDeadlineFor('swap_component'),
        () => figmaCtx.importComponentByKeyAsync(key),
        LIBRARY_DEFERRAL_ADVICE,
      );
    } else {
      const node = await figmaCtx.getNodeByIdAsync(p.componentId as string);
      if (node === null || node.type !== 'COMPONENT') {
        throw new Error(`swap_component: component ${String(p.componentId)} not found`);
      }
      component = node as ComponentNode;
    }
    (instance as InstanceNode).swapComponent(component);

    const result: MutateResult = { ok: true, nodeId: instance.id };
    return result;
  };
