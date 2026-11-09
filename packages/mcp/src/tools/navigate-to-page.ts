import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const NAVIGATE_TO_PAGE_TOOL_NAME = 'navigate_to_page';

export const navigateToPageTool: ToolSpec = {
  name: NAVIGATE_TO_PAGE_TOOL_NAME,
  description:
    'Switch the active page. Subsequent selection and reads without an explicit root operate on this page. ' +
    'If loading the page exhausts the connection-timeout retry, attempts a direct switch; success includes a note that the load timed out and the page was switched directly. ' +
    'search_nodes, scan_nodes_by_types and scan_text_nodes load an explicit page root without switching pages. ' +
    'Returns { ok, nodeId, note? }.',
  inputSchema: z.object({
    pageId: z.string().describe('Page id to navigate to'),
  }),
  kind: 'write',
};
