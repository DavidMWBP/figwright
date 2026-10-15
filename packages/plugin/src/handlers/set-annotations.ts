import { SetAnnotationsItemSchema } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';

export const createSetAnnotationsHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const p = (params ?? {}) as { mode?: unknown; items?: unknown };
    if (p.mode !== 'append' && p.mode !== 'replace')
      throw new Error('set_annotations: mode must be append or replace');
    if (!Array.isArray(p.items) || p.items.length === 0)
      throw new Error('set_annotations: items must be a non-empty array');

    const seen = new Set<string>();
    const plan: { node: BaseNode & AnnotationsMixin; annotations: Annotation[] }[] = [];
    for (const [index, item] of p.items.entries()) {
      try {
        const checked = SetAnnotationsItemSchema.safeParse(item);
        if (!checked.success)
          throw new Error(
            checked.error.issues
              .map(issue => `${issue.path.join('.')}: ${issue.message}`)
              .join('; '),
          );
        const parsed = checked.data;
        if (seen.has(parsed.nodeId)) throw new Error(`duplicate nodeId ${parsed.nodeId}`);
        seen.add(parsed.nodeId);
        if (p.mode === 'append' && parsed.annotations.length === 0)
          throw new Error('append annotations must not be empty');
        const node = await figmaCtx.getNodeByIdAsync(parsed.nodeId);
        if (node === null || !('annotations' in node))
          throw new Error(`node ${parsed.nodeId} not found or does not support annotations`);
        for (const annotation of parsed.annotations) {
          if (annotation.label !== undefined && annotation.labelMarkdown !== undefined)
            throw new Error('annotation cannot have both label and labelMarkdown');
          const label = annotation.label ?? annotation.labelMarkdown;
          if (label !== undefined && label.trim() === '')
            throw new Error('annotation label must not be blank');
          if (label === undefined && !annotation.properties?.length)
            throw new Error('annotation needs label, labelMarkdown or non-empty properties');
          if (
            annotation.categoryId !== undefined &&
            (await figmaCtx.annotations.getAnnotationCategoryByIdAsync(annotation.categoryId)) ===
              null
          )
            throw new Error(`unknown categoryId ${annotation.categoryId}`);
        }
        plan.push({
          node,
          annotations: parsed.annotations.map(annotation => ({
            ...(annotation.label !== undefined && { label: annotation.label }),
            ...(annotation.labelMarkdown !== undefined && {
              labelMarkdown: annotation.labelMarkdown,
            }),
            ...(annotation.categoryId !== undefined && { categoryId: annotation.categoryId }),
            ...(annotation.properties !== undefined && { properties: annotation.properties }),
          })),
        });
      } catch (error) {
        throw new Error(
          `set_annotations: item ${index}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    const results = plan.map(({ node, annotations }) => {
      node.annotations = p.mode === 'append' ? [...node.annotations, ...annotations] : annotations;
      return { nodeId: node.id, count: node.annotations.length };
    });
    return { ok: true, results };
  };
