import type { GetNodeResult, SerializedNode } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { NodeReadError, readNode } from '../node-read.js';
import { resultCharBudget, serializeTrees, treeTooLargeError } from '../serializer.js';

const isSceneNode = (node: BaseNode): node is SceneNode =>
  node.type !== 'DOCUMENT' && node.type !== 'PAGE';

const serializeWithin = async (
  node: SceneNode,
  figmaCtx: typeof figma,
): Promise<SerializedNode> => {
  const run = await serializeTrees([node], resultCharBudget(), figmaCtx);
  if (!run.complete) throw treeTooLargeError('get_node', run.total);
  return run.nodes[0]!;
};

export const createGetNodeHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const nodeId = (params as { nodeId?: unknown } | null)?.nodeId;
    if (typeof nodeId !== 'string') {
      throw new TypeError('get_node: nodeId must be a string');
    }
    const node = await figmaCtx.getNodeByIdAsync(nodeId);
    try {
      const scene =
        node === null
          ? null
          : readNode(node, 'native fields', () => (isSceneNode(node) ? node : null));
      const result: GetNodeResult = {
        node: scene === null ? null : await serializeWithin(scene, figmaCtx),
      };
      return result;
    } catch (error) {
      if (error instanceof NodeReadError) throw await error.advise(figmaCtx);
      throw error;
    }
  };
