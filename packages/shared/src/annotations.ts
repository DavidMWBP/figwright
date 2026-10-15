import { z } from 'zod';

// @figma/plugin-typings 1.141.0, AnnotationPropertyType.
const AnnotationPropertyTypeSchema = z.enum([
  'width',
  'height',
  'maxWidth',
  'minWidth',
  'maxHeight',
  'minHeight',
  'fills',
  'strokes',
  'effects',
  'strokeWeight',
  'cornerRadius',
  'textStyleId',
  'textAlignHorizontal',
  'fontFamily',
  'fontStyle',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'itemSpacing',
  'padding',
  'layoutMode',
  'alignItems',
  'opacity',
  'mainComponent',
  'gridRowGap',
  'gridColumnGap',
  'gridRowCount',
  'gridColumnCount',
  'gridRowAnchorIndex',
  'gridColumnAnchorIndex',
  'gridRowSpan',
  'gridColumnSpan',
]);

export const SetAnnotationsItemSchema = z.object({
  nodeId: z.string(),
  annotations: z.array(
    z.object({
      label: z.string().optional(),
      labelMarkdown: z.string().optional(),
      categoryId: z.string().optional(),
      properties: z.array(z.object({ type: AnnotationPropertyTypeSchema })).optional(),
    }),
  ),
});
