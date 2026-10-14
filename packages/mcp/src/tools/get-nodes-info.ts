import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const GET_NODES_INFO_TOOL_NAME = 'get_nodes_info';

export const getNodesInfoTool: ToolSpec = {
  name: GET_NODES_INFO_TOOL_NAME,
  description:
    'Return multiple Figma nodes by id. Output preserves input order; missing ids and non-scene nodes slot null. ' +
    'Rejected lookups also slot null and appear in optional lookupErrors entries with index (zero-based input position), nodeId, and message. ' +
    'Every failed occurrence is reported, including duplicates and when all lookups reject; a rejection is not proof of a missing id. ' +
    'One loaded-page health probe is shared per call. If it works, the target failed while the session answered other reads: ' +
    'the id may be missing, deleted, on a page not loaded, or not yet synced from another client. ' +
    'A plugin reload is not indicated; try exporting the node or reading its parent. ' +
    'If the probe also fails, the session is not answering reads; reload the plugin.',
  inputSchema: z.object({ nodeIds: z.array(z.string()).describe('Figma node ids to fetch') }),
  kind: 'read',
};
