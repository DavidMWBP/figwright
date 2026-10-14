import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const GET_NODE_TOOL_NAME = 'get_node';

export const getNodeTool: ToolSpec = {
  name: GET_NODE_TOOL_NAME,
  description:
    'Return one node by id with its full recursive subtree at maximum fidelity — every serialized ' +
    'field (geometry, paints, effects, auto-layout, text with per-run segments, style/variable ids, ' +
    'mainComponent), no depth limit, no deduplication. Best for inspecting a single component or a ' +
    'node you are about to modify; for exploring or grounding anything large, prefer ' +
    'get_design_context (depth-limited, deduped, tokens resolved to names). Returns { node }, ' +
    'null when the lookup resolves without a scene node. A rejected lookup remains an error, not proof of a missing id. ' +
    'If the loaded-page probe works, the error means the target failed while the session answered other reads: ' +
    'the id may be missing, deleted, on a page not loaded, or not yet synced from another client. ' +
    'A plugin reload is not indicated; try exporting the node or reading its parent. ' +
    'If the probe also fails, the session is not answering reads; reload the plugin.',
  inputSchema: z.object({
    nodeId: z.string().describe('Figma node id, e.g. "1:42"; a pasted Figma URL also works'),
  }),
  kind: 'read',
};
