import { describe, expect, it } from 'vitest';

import { createSetAnnotationsHandler } from '../../src/handlers/set-annotations.js';

const fakeFigma = (lookup: Record<string, unknown>): typeof figma =>
  ({
    getNodeByIdAsync: async (id: string) => lookup[id] ?? null,
    annotations: {
      getAnnotationCategoryByIdAsync: async (id: string) => (id === 'known' ? { id } : null),
    },
  }) as unknown as typeof figma;

describe('set_annotations handler', () => {
  it.each([
    ['blank label', [{ label: '   ' }], /label/],
    ['both labels', [{ label: 'plain', labelMarkdown: '**rich**' }], /both/],
    ['no content', [{}], /label.*properties/],
    ['empty properties', [{ properties: [] }], /label.*properties/],
    ['unknown category', [{ label: 'note', categoryId: 'missing' }], /category/],
    ['invalid property', [{ properties: [{ type: 'unknown' }] }], /propert/],
  ])('refuses %s before writing any item', async (_name, annotations, reason) => {
    const node = { id: '1:1', annotations: [{ label: 'before' }] };
    const other = { id: '1:2', annotations: [] };
    const handler = createSetAnnotationsHandler(fakeFigma({ '1:1': node, '1:2': other }));
    const error = await Promise.resolve(
      handler({
        mode: 'replace',
        items: [
          { nodeId: '1:1', annotations: [{ label: 'after' }] },
          { nodeId: '1:2', annotations },
        ],
      }),
    ).catch((e: Error) => e);
    expect({ error, annotations: node.annotations }).toEqual({
      error: expect.objectContaining({
        message: expect.stringMatching(new RegExp(`item 1.*${reason.source}`)),
      }),
      annotations: [{ label: 'before' }],
    });
  });

  it('replace with [] clears and returns count 0', async () => {
    const node = { id: '1:1', annotations: [{ label: 'before' }] };
    const result = await createSetAnnotationsHandler(fakeFigma({ '1:1': node }))({
      mode: 'replace',
      items: [{ nodeId: '1:1', annotations: [] }],
    });
    expect({ result, annotations: node.annotations }).toEqual({
      result: { ok: true, results: [{ nodeId: '1:1', count: 0 }] },
      annotations: [],
    });
  });

  it('refuses append with []', async () => {
    const handler = createSetAnnotationsHandler(
      fakeFigma({ '1:1': { id: '1:1', annotations: [] } }),
    );
    await expect(
      handler({ mode: 'append', items: [{ nodeId: '1:1', annotations: [] }] }),
    ).rejects.toThrow(/item 0.*empty/);
  });

  it('refuses duplicate nodeId with nothing written', async () => {
    const node = { id: '1:1', annotations: [{ label: 'before' }] };
    const item = { nodeId: '1:1', annotations: [{ label: 'after' }] };
    const error = await Promise.resolve(
      createSetAnnotationsHandler(fakeFigma({ '1:1': node }))({
        mode: 'replace',
        items: [item, item],
      }),
    ).catch((e: Error) => e);
    expect({ error, annotations: node.annotations }).toEqual({
      error: expect.objectContaining({ message: expect.stringMatching(/item 1.*duplicate/) }),
      annotations: [{ label: 'before' }],
    });
  });

  it.each([
    ['page', { id: '1:1', type: 'PAGE' }],
    ['missing', undefined],
  ])('refuses a %s node', async (_name, node) => {
    await expect(
      createSetAnnotationsHandler(fakeFigma({ '1:1': node }))({
        mode: 'replace',
        items: [{ nodeId: '1:1', annotations: [] }],
      }),
    ).rejects.toThrow(/item 0.*annotations/);
  });

  it('refuses empty items', async () => {
    await expect(
      createSetAnnotationsHandler(fakeFigma({}))({ mode: 'replace', items: [] }),
    ).rejects.toThrow(/items.*empty/);
  });

  it('requires a valid mode', async () => {
    await expect(createSetAnnotationsHandler(fakeFigma({}))({ items: [] })).rejects.toThrow(/mode/);
  });

  it('appends after existing annotations in order, preserving every field', async () => {
    const node = { id: '1:1', annotations: [{ label: 'before' }] };
    await createSetAnnotationsHandler(fakeFigma({ '1:1': node }))({
      mode: 'append',
      items: [
        {
          nodeId: '1:1',
          annotations: [
            { labelMarkdown: '**after**', categoryId: 'known', properties: [{ type: 'fills' }] },
            { properties: [{ type: 'width' }] },
          ],
        },
      ],
    });
    expect(node.annotations).toEqual([
      { label: 'before' },
      { labelMarkdown: '**after**', categoryId: 'known', properties: [{ type: 'fills' }] },
      { properties: [{ type: 'width' }] },
    ]);
  });

  it('handles 300 items with 200-character labels', async () => {
    const nodes = Array.from({ length: 300 }, (_, i) => ({
      id: `1:${i}`,
      annotations: [] as Annotation[],
    }));
    const result = await createSetAnnotationsHandler(
      fakeFigma(Object.fromEntries(nodes.map(n => [n.id, n]))),
    )({
      mode: 'replace',
      items: nodes.map(n => ({ nodeId: n.id, annotations: [{ label: 'x'.repeat(200) }] })),
    });
    expect({ result, labels: nodes.map(n => n.annotations[0]?.label) }).toEqual({
      result: { ok: true, results: nodes.map(n => ({ nodeId: n.id, count: 1 })) },
      labels: Array(300).fill('x'.repeat(200)),
    });
  });

  it('reports the count read back from the node', async () => {
    const node = {
      id: '1:1',
      get annotations() {
        return [{ label: 'retained' }];
      },
      set annotations(_value: Annotation[]) {},
    };
    expect(
      await createSetAnnotationsHandler(fakeFigma({ '1:1': node }))({
        mode: 'replace',
        items: [{ nodeId: '1:1', annotations: [{ label: 'a' }, { label: 'b' }] }],
      }),
    ).toEqual({ ok: true, results: [{ nodeId: '1:1', count: 1 }] });
  });
});
