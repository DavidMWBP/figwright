import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const SAVE_VERSION_TOOL_NAME = 'save_version';

export const saveVersionTool: ToolSpec = {
  name: SAVE_VERSION_TOOL_NAME,
  description:
    "Save a named version to the open file's version history. Returns { ok, versionId, fileName }. " +
    'Call it before the writes it should protect, because Figma may leave out changes made in the moment before the call. ' +
    'versionId is null when Figma did not return an id. ' +
    'The version applies to the file the plugin is connected to (see use_file).',
  inputSchema: z.object({
    title: z
      .string()
      .regex(/\S/)
      .describe('Version title with at least one non-whitespace character'),
    description: z.string().optional().describe('Optional version description'),
  }),
  kind: 'write',
};
