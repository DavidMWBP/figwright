import { z } from 'zod';

import { animationStyleConfigSchema } from './motion-schemas.js';
import type { ToolSpec } from './spec.js';

export const APPLY_ANIMATION_STYLE_TOOL_NAME = 'apply_animation_style';

export const applyAnimationStyleTool: ToolSpec = {
  name: APPLY_ANIMATION_STYLE_TOOL_NAME,
  description:
    'Apply a Figma Motion animation-style preset to a node (get styleIds from get_motion_styles). ' +
    'config tunes it: duration (seconds), timelineOffset (seconds — the lever for staggered ' +
    'entrances: give each node index * step), and preset-specific props. Returns ' +
    '{ ok, nodeId, appliedStyleId } — keep appliedStyleId to remove exactly this instance later. To ' +
    'stagger a whole row in one call with rollback, drive N apply_animation_style ops through ' +
    '`batch` with increasing timelineOffset. A timeout can leave an unknown outcome; read back ' +
    'before retrying. Motion is a Figma-Design-only beta feature.',
  inputSchema: z.object({
    nodeId: z.string().describe('Figma node id to animate'),
    styleId: z.string().describe('A styleId from get_motion_styles'),
    config: animationStyleConfigSchema
      .describe('Optional tuning: duration, timelineOffset (for stagger), preset props')
      .optional(),
  }),
  kind: 'write',
};
