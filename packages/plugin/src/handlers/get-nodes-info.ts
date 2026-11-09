import type { GetNodesInfoResult, SerializedNode } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { NodeReadError, readNode } from '../node-read.js';
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
    // Each tree is bounded; only complete, successful trees count toward the combined result.
    const failures: Array<{ index: number; nodeId: string; error: unknown }> = [];
    const serializationErrors: NonNullable<GetNodesInfoResult['serializationErrors']> = [];
    const runs = await Promise.all(
      ids.map(async (id, index) => {
        let node: BaseNode | null;
        try {
          node = await figmaCtx.getNodeByIdAsync(id);
        } catch (error) {
          failures.push({ index, nodeId: id, error });
          return null;
        }
        try {
          if (node === null) return null;
          const scene = readNode(node, 'native fields', () => (isSceneNode(node) ? node : null));
          if (scene === null) return null;
          const budget = resultCharBudget();
          const run = await serializeTrees([scene], budget, figmaCtx);
          return { id, run, budget };
        } catch (error) {
          if (!(error instanceof NodeReadError)) throw error;
          await error.advise(figmaCtx);
          serializationErrors.push({
            index,
            nodeId: error.nodeId,
            stage: error.stage,
            message: error.message,
          });
          return null;
        }
      }),
    );
    failures.sort((a, b) => a.index - b.index);
    const totalChars = runs.reduce((sum, entry) => sum + (entry?.budget.used ?? 0), 0);
    if (
      runs.some(entry => entry !== null && !entry.run.complete) ||
      totalChars > resultCharBudget().limit
    ) {
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
    if (serializationErrors.length > 0) {
      result.serializationErrors = serializationErrors.toSorted((a, b) => a.index - b.index);
    }
    if (failures.length > 0) {
      result.lookupErrors = failures.map(({ index, nodeId, error }) => ({
        index,
        nodeId,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    return result;
  };
