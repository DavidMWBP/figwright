import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
  relaunchButtons?: { command: string; name: string }[];
};

const fakeFigma = (editorType = 'figma', command = '') => ({
  editorType,
  command,
  mode: 'default',
  apiVersion: '1.0.0',
  root: { name: 'Test file', setRelaunchData: vi.fn() },
  currentPage: { id: '0:1', name: 'Page 1', selection: [] },
  showUI: vi.fn(),
  on: vi.fn(),
  ui: { postMessage: vi.fn(), show: vi.fn() },
  clientStorage: { getAsync: vi.fn().mockResolvedValue(undefined) },
});

const start = async (f: ReturnType<typeof fakeFigma>) => {
  vi.stubGlobal('figma', f);
  vi.stubGlobal('__html__', '<html></html>');
  await import('../src/code.js');
};

describe('plugin startup relaunch button', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it.each(['', 'run-figwright'])(
    'registers the file button and opens the UI for command %j',
    async command => {
      const f = fakeFigma('figma', command);
      await start(f);
      expect(f.root.setRelaunchData).toHaveBeenCalledExactlyOnceWith({ 'run-figwright': '' });
      expect(f.showUI).toHaveBeenCalledWith('<html></html>', expect.any(Object));
      expect(f.ui.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'context' }));
    },
  );

  it('declares one named manifest button matching the startup constant', async () => {
    const f = fakeFigma();
    await start(f);
    expect(manifest.relaunchButtons).toEqual([{ command: 'run-figwright', name: 'Run Figwright' }]);
    const { RELAUNCH_COMMAND } = await import('../src/relaunch.js');
    expect(manifest.relaunchButtons).toEqual([
      { command: RELAUNCH_COMMAND, name: 'Run Figwright' },
    ]);
    expect(f.root.setRelaunchData).toHaveBeenCalledWith({ [RELAUNCH_COMMAND]: '' });
  });

  it.each(['figjam', 'dev'])(
    'skips root registration in %s while starting normally',
    async editorType => {
      const f = fakeFigma(editorType);
      await expect(start(f)).resolves.toBeUndefined();
      expect(f.root.setRelaunchData).not.toHaveBeenCalled();
      expect(f.showUI).toHaveBeenCalled();
      expect(f.ui.postMessage).toHaveBeenCalled();
    },
  );

  it('continues startup when file permissions reject relaunch data', async () => {
    const f = fakeFigma();
    f.root.setRelaunchData.mockImplementation(() => {
      throw new Error('Read-only file');
    });
    await expect(start(f)).resolves.toBeUndefined();
    expect(f.showUI).toHaveBeenCalled();
    expect(f.ui.postMessage).toHaveBeenCalled();
  });

  it('writes the same single button when the file already has relaunch data', async () => {
    const f = fakeFigma();
    let data = { 'run-figwright': '' };
    f.root.setRelaunchData.mockImplementation(next => {
      data = next;
    });
    await start(f);
    vi.resetModules();
    await start(f);
    expect(f.root.setRelaunchData).toHaveBeenCalledTimes(2);
    expect(data).toEqual({ 'run-figwright': '' });
  });
});
