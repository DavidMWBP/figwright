import { SetAnnotationsItemSchema } from '@figwright/shared';
import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const setAnnotationsTool: ToolSpec = {
  name: 'set_annotations',
  description:
    'Write Dev Mode annotations on many nodes. Required mode append adds after existing annotations; ' +
    'replace sets the exact list, and [] clears it. Append requires a non-empty list. ' +
    'All items are validated before any write; duplicate nodeIds, unsupported nodes, unknown categories, ' +
    'blank labels, both label and labelMarkdown, or annotations without a label or properties are refused. ' +
    'Use get_annotations to read them back (its properties are names; writes use { type } objects). ' +
    'Capacity depends on encoded bytes, not an item cap: keep the complete request below 10 MiB and ' +
    'the escaped result below 10 MiB minus 16 KiB. For a minimal tools/call request (id 1), sequential ' +
    'nodeIds 1:0 onward and one 200-byte ASCII label each, 41,986 items fit; 41,987 exceed the request limit. ' +
    'Longer ids, Unicode, escaping and metadata reduce capacity. At least 300 such items fit comfortably. ' +
    'Returns { ok: true, results: [{ nodeId, count }] }, with counts read back after writing.',
  inputSchema: z.object({
    items: z.array(SetAnnotationsItemSchema).min(1),
    mode: z.enum(['append', 'replace']),
  }),
  kind: 'write',
};
