import { probeLoadedPage } from './node-lookup.js';

/** A failed native read belongs to the node being read, which may be deep inside a requested tree. */
export class NodeReadError extends Error {
  readonly nodeId: string;
  readonly stage: string;

  constructor(node: BaseNode, stage: string, cause: unknown) {
    // Even the diagnostic fields are native getters. Their failure must not hide the first error.
    let nodeId = 'unknown';
    let name: string | undefined;
    try {
      nodeId = node.id;
    } catch {
      /* best effort */
    }
    try {
      name = node.name;
    } catch {
      /* best effort */
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    // Main-component failures already carry their Figma call boundary.
    const message =
      stage === 'main component' && detail.startsWith('getMainComponentAsync(')
        ? detail
        : `serializeNode(${nodeId}) failed: ${detail}`;
    super(
      `${message} (node ${nodeId}${name === undefined ? '' : ` ${JSON.stringify(name)}`}, read stage: ${stage})`,
      { cause },
    );
    this.nodeId = nodeId;
    this.stage = stage;
  }

  async advise(figmaCtx: typeof figma): Promise<this> {
    this.message += (await probeLoadedPage(figmaCtx))
      ? ' The current page still answers; the target read failed while the session answered other reads. A plugin reload is not indicated; try exporting the node or reading its parent.'
      : ' The session is not answering reads: the loaded-page health probe failed too. Reload the plugin to restore reads.';
    return this;
  }
}

/** Attribute a synchronous native read without retrying it or changing successful output. */
export const readNode = <T>(node: BaseNode, stage: string, read: () => T): T => {
  try {
    return read();
  } catch (cause) {
    throw new NodeReadError(node, stage, cause);
  }
};
