export const RELAUNCH_COMMAND = 'run-figwright';

export const registerRelaunchButton = (figmaCtx: typeof figma): void => {
  // Root buttons with nothing selected are documented for Figma Design, not FigJam.
  // Keep registration in Design even though Dev Mode permits some metadata writes.
  if (figmaCtx.editorType !== 'figma') return;
  try {
    // Replacing identical relaunch data keeps the same single button on every page.
    figmaCtx.root.setRelaunchData({ [RELAUNCH_COMMAND]: '' });
  } catch {
    // File permissions may reject the write; a shortcut must never block startup.
  }
};
