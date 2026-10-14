import type { GetNodesInfoResult, SerializedNode } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { RESULT_LIMIT_LABEL, resultCharBudget, serializeTrees } from '../serializer.js';

const isSceneNode = (node: BaseNode): node is SceneNode =>
  node.type !== 'DOCUMENT' && node.type !== 'PAGE';

export const createGetNodesInfoHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const nodeIds = (params as { nodeIds?: unknown } | null)?.nodeIds;
    if (!Array.isArray(nodeIds) || nodeIds.some(id => typeof id !== 'string')) {
      throw new TypeError('get_nodes_info: nodeIds must be a string[]');
    }
    const ids = nodeIds as readonly string[];
    // One allowance for every tree: they come back in one result, so it is their sum that has to
    // fit — and that the sandbox has to hold at once.
    const budget = resultCharBudget();
    const failures: Array<{ index: number; nodeId: string; error: unknown }> = [];
    const runs = await Promise.all(
      ids.map(async (id, index) => {
        let node: BaseNode | null;
        try {
          node = await figmaCtx.getNodeByIdAsync(id);
        } catch (error) {
          failures.push({ index, nodeId: id, error });
          return null;
        }
        if (node === null || !isSceneNode(node)) return null;
        return { id, run: await serializeTrees([node], budget) };
      }),
    );
    failures.sort((a, b) => a.index - b.index);
    if (ids.length > 0 && failures.length === ids.length) throw failures[0]!.error;
    if (runs.some(entry => entry !== null && !entry.run.complete)) {
      const sizes = runs
        .filter(entry => entry !== null)
        .map(entry => `${entry.id}: ${entry.run.total} nodes`)
        .join(', ');
      throw new Error(
        `get_nodes_info: the requested trees together serialize past ${RESULT_LIMIT_LABEL} — more ` +
          `than one tool result can carry (${sizes}). Ask for fewer ids per call, or read a large ` +
          'one in parts: get_node on one of its children, or get_design_context, which splits a ' +
          'large tree into sections.',
      );
    }
    const nodes: Array<SerializedNode | null> = runs.map(entry =>
      entry === null ? null : entry.run.nodes[0]!,
    );
    const result: GetNodesInfoResult = { nodes };
    if (failures.length > 0) {
      result.lookupErrors = failures.map(({ index, nodeId, error }) => ({
        index,
        nodeId,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    return result;
  };
