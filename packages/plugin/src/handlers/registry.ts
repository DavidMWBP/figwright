import type { SandboxHandlers, SandboxToolHandler } from '../dispatcher.js';
import { createIdempotencyCache, idempotent } from '../idempotency.js';
import { withInstanceIdLookup } from '../node-lookup.js';
import type { ReadRetryState } from '../read-retry.js';
import { createAddComponentPropertyHandler } from './add-component-property.js';
import { createAddPageHandler } from './add-page.js';
import { createAddVariableModeHandler } from './add-variable-mode.js';
import { createApplyAnimationStyleHandler } from './apply-animation-style.js';
import { createApplyManualKeyframeTrackHandler } from './apply-manual-keyframe-track.js';
import { createApplyStyleToNodeHandler } from './apply-style-to-node.js';
import { createBatchRenameNodesHandler } from './batch-rename-nodes.js';
import { createBatchHandler } from './batch.js';
import { createBindComponentPropertyHandler } from './bind-component-property.js';
import { createBindVariableToNodeHandler } from './bind-variable-to-node.js';
import { createBindVariableToPaintHandler } from './bind-variable-to-paint.js';
import { createCloneNodeHandler } from './clone-node.js';
import { createCombineAsVariantsHandler } from './combine-as-variants.js';
import { createCreateComponentHandler } from './create-component.js';
import { createCreateEffectStyleHandler } from './create-effect-style.js';
import { createCreateEllipseHandler } from './create-ellipse.js';
import { createCreateFrameHandler } from './create-frame.js';
import { createCreateGridStyleHandler } from './create-grid-style.js';
import { createCreateInstanceHandler } from './create-instance.js';
import { createCreatePaintStyleHandler } from './create-paint-style.js';
import { createCreateRectangleHandler } from './create-rectangle.js';
import { createCreateSectionHandler } from './create-section.js';
import { createCreateTextStyleHandler } from './create-text-style.js';
import { createCreateTextHandler } from './create-text.js';
import { createCreateVariableCollectionHandler } from './create-variable-collection.js';
import { createCreateVariableHandler } from './create-variable.js';
import { createDeleteComponentPropertyHandler } from './delete-component-property.js';
import { createDeleteNodesHandler } from './delete-nodes.js';
import { createDeletePageHandler } from './delete-page.js';
import { createDeleteStyleHandler } from './delete-style.js';
import { createDeleteVariableCollectionHandler } from './delete-variable-collection.js';
import { createDeleteVariableModeHandler } from './delete-variable-mode.js';
import { createDeleteVariableHandler } from './delete-variable.js';
import { createDetachInstanceHandler } from './detach-instance.js';
import { createEditComponentPropertyHandler } from './edit-component-property.js';
import { createExportPdfHandler } from './export-pdf.js';
import { createExportVideoHandler } from './export-video.js';
import { createFindReplaceTextHandler } from './find-replace-text.js';
import { createGetAnnotationsHandler } from './get-annotations.js';
import { createGetComponentApiHandler } from './get-component-api.js';
import { createGetDesignContextHandler } from './get-design-context.js';
import { createGetDocumentHandler } from './get-document.js';
import { createGetFontsHandler } from './get-fonts.js';
import { createGetLocalComponentsHandler } from './get-local-components.js';
import { createGetMetadataHandler } from './get-metadata.js';
import { createGetMotionContextHandler } from './get-motion-context.js';
import { createGetMotionStylesHandler } from './get-motion-styles.js';
import { createGetNodeMotionHandler } from './get-node-motion.js';
import { createGetNodeHandler } from './get-node.js';
import { createGetNodesInfoHandler } from './get-nodes-info.js';
import { createGetPagesHandler } from './get-pages.js';
import { createGetReactionsHandler } from './get-reactions.js';
import { createGetScreenshotHandler } from './get-screenshot.js';
import { createGetSelectionHandler } from './get-selection.js';
import { createGetStylesHandler } from './get-styles.js';
import { createGetVariableDefsHandler } from './get-variable-defs.js';
import { createGetViewportHandler } from './get-viewport.js';
import { createGroupNodesHandler } from './group-nodes.js';
import { createImportImageHandler } from './import-image.js';
import { createImportStyleHandler } from './import-style.js';
import { createImportSvgHandler } from './import-svg.js';
import { createImportVariableHandler } from './import-variable.js';
import { createListFilesHandler } from './list-files.js';
import { createSetLockedHandler } from './lock-nodes.js';
import { createMoveNodesHandler } from './move-nodes.js';
import { createNavigateToPageHandler } from './navigate-to-page.js';
import { createPingHandler } from './ping.js';
import { createRemoveAnimationStyleHandler } from './remove-animation-style.js';
import { createRemoveManualKeyframeTrackHandler } from './remove-manual-keyframe-track.js';
import { createRemoveReactionsHandler } from './remove-reactions.js';
import { createRenameNodeHandler } from './rename-node.js';
import { createRenamePageHandler } from './rename-page.js';
import { createRenameVariableHandler } from './rename-variable.js';
import { createReorderNodesHandler } from './reorder-nodes.js';
import { createReparentNodesHandler } from './reparent-nodes.js';
import { createResizeNodesHandler } from './resize-nodes.js';
import { createRotateNodesHandler } from './rotate-nodes.js';
import { createSaveImageFillsHandler } from './save-image-fills.js';
import { createSaveVersionHandler } from './save-version.js';
import { createScanNodesByTypesHandler } from './scan-nodes-by-types.js';
import { createScanTextNodesHandler } from './scan-text-nodes.js';
import { createSearchNodesHandler } from './search-nodes.js';
import { createSetAnnotationsHandler } from './set-annotations.js';
import { createSetArcHandler } from './set-arc.js';
import { createSetAutoLayoutHandler } from './set-auto-layout.js';
import { createSetBlendModeHandler } from './set-blend-mode.js';
import { createSetConstraintsHandler } from './set-constraints.js';
import { createSetCornerRadiusHandler } from './set-corner-radius.js';
import { createSetEffectsHandler } from './set-effects.js';
import { createSetFillsHandler } from './set-fills.js';
import { createSetImageFillHandler } from './set-image-fill.js';
import { createSetInstancePropertiesHandler } from './set-instance-properties.js';
import { createSetLayoutGridsHandler } from './set-layout-grids.js';
import { createSetLayoutPropsHandler } from './set-layout-props.js';
import { createSetMaskHandler } from './set-mask.js';
import { createSetNodeVariableModeHandler } from './set-node-variable-mode.js';
import { createSetOpacityHandler } from './set-opacity.js';
import { createSetPositionHandler } from './set-position.js';
import { createSetReactionsHandler } from './set-reactions.js';
import { createSetStrokesHandler } from './set-strokes.js';
import { createSetTextPropertiesHandler } from './set-text-properties.js';
import { createSetTextRangeHandler } from './set-text-range.js';
import { createSetTextHandler } from './set-text.js';
import { createSetTimelineDurationHandler } from './set-timeline-duration.js';
import { createSetVariableCodeSyntaxHandler } from './set-variable-code-syntax.js';
import { createSetVariableValueHandler } from './set-variable-value.js';
import { createSetVisibleHandler } from './set-visible.js';
import { createSwapComponentHandler } from './swap-component.js';
import { createUngroupNodesHandler } from './ungroup-nodes.js';
import { createUpdateEffectStyleHandler } from './update-effect-style.js';
import { createUpdateFlowsHandler } from './update-flows.js';
import { createUpdatePaintStyleHandler } from './update-paint-style.js';
import { createUpdateTextStyleHandler } from './update-text-style.js';
import { createUpdateVariableCollectionHandler } from './update-variable-collection.js';

const writeFactories: Record<string, (figmaCtx: typeof figma) => SandboxToolHandler> = {
  set_fills: createSetFillsHandler,
  set_text: createSetTextHandler,
  set_text_properties: createSetTextPropertiesHandler,
  set_text_range: createSetTextRangeHandler,
  create_frame: createCreateFrameHandler,
  set_opacity: createSetOpacityHandler,
  set_visible: createSetVisibleHandler,
  set_annotations: createSetAnnotationsHandler,
  rename_node: createRenameNodeHandler,
  delete_nodes: createDeleteNodesHandler,
  create_text: createCreateTextHandler,
  create_rectangle: createCreateRectangleHandler,
  set_corner_radius: createSetCornerRadiusHandler,
  set_strokes: createSetStrokesHandler,
  move_nodes: createMoveNodesHandler,
  resize_nodes: createResizeNodesHandler,
  set_auto_layout: createSetAutoLayoutHandler,
  set_layout_props: createSetLayoutPropsHandler,
  set_layout_grids: createSetLayoutGridsHandler,
  set_position: createSetPositionHandler,
  set_blend_mode: createSetBlendModeHandler,
  set_mask: createSetMaskHandler,
  set_arc: createSetArcHandler,
  set_constraints: createSetConstraintsHandler,
  rotate_nodes: createRotateNodesHandler,
  lock_nodes: figmaCtx => createSetLockedHandler(figmaCtx, true),
  unlock_nodes: figmaCtx => createSetLockedHandler(figmaCtx, false),
  clone_node: createCloneNodeHandler,
  // Styles
  set_effects: createSetEffectsHandler,
  create_paint_style: createCreatePaintStyleHandler,
  create_text_style: createCreateTextStyleHandler,
  create_effect_style: createCreateEffectStyleHandler,
  create_grid_style: createCreateGridStyleHandler,
  update_paint_style: createUpdatePaintStyleHandler,
  update_text_style: createUpdateTextStyleHandler,
  update_effect_style: createUpdateEffectStyleHandler,
  apply_style_to_node: createApplyStyleToNodeHandler,
  import_style: createImportStyleHandler,
  delete_style: createDeleteStyleHandler,
  // Variables
  create_variable_collection: createCreateVariableCollectionHandler,
  update_variable_collection: createUpdateVariableCollectionHandler,
  add_variable_mode: createAddVariableModeHandler,
  create_variable: createCreateVariableHandler,
  set_variable_value: createSetVariableValueHandler,
  bind_variable_to_node: createBindVariableToNodeHandler,
  bind_variable_to_paint: createBindVariableToPaintHandler,
  import_variable: createImportVariableHandler,
  set_node_variable_mode: createSetNodeVariableModeHandler,
  rename_variable: createRenameVariableHandler,
  set_variable_code_syntax: createSetVariableCodeSyntaxHandler,
  delete_variable: createDeleteVariableHandler,
  delete_variable_mode: createDeleteVariableModeHandler,
  delete_variable_collection: createDeleteVariableCollectionHandler,
  // Structure + bulk text
  group_nodes: createGroupNodesHandler,
  ungroup_nodes: createUngroupNodesHandler,
  reparent_nodes: createReparentNodesHandler,
  reorder_nodes: createReorderNodesHandler,
  find_replace_text: createFindReplaceTextHandler,
  batch_rename_nodes: createBatchRenameNodesHandler,
  // Pages
  add_page: createAddPageHandler,
  delete_page: createDeletePageHandler,
  rename_page: createRenamePageHandler,
  navigate_to_page: createNavigateToPageHandler,
  save_version: createSaveVersionHandler,
  // Prototype + components
  set_reactions: createSetReactionsHandler,
  remove_reactions: createRemoveReactionsHandler,
  update_flows: createUpdateFlowsHandler,
  swap_component: createSwapComponentHandler,
  set_instance_properties: createSetInstancePropertiesHandler,
  add_component_property: createAddComponentPropertyHandler,
  bind_component_property: createBindComponentPropertyHandler,
  edit_component_property: createEditComponentPropertyHandler,
  delete_component_property: createDeleteComponentPropertyHandler,
  detach_instance: createDetachInstanceHandler,
  import_image: createImportImageHandler,
  set_image_fill: createSetImageFillHandler,
  import_svg: createImportSvgHandler,
  create_ellipse: createCreateEllipseHandler,
  create_component: createCreateComponentHandler,
  create_section: createCreateSectionHandler,
  create_instance: createCreateInstanceHandler,
  combine_as_variants: createCombineAsVariantsHandler,
  // Motion (beta) — Figma Design only
  apply_animation_style: createApplyAnimationStyleHandler,
  remove_animation_style: createRemoveAnimationStyleHandler,
  apply_manual_keyframe_track: createApplyManualKeyframeTrackHandler,
  remove_manual_keyframe_track: createRemoveManualKeyframeTrackHandler,
  set_timeline_duration: createSetTimelineDurationHandler,
};

/**
 * Every sandbox write tool: the idempotent writes plus `batch`. The dispatcher runs these one at a
 * time, so one batch's capture/apply/rollback never interleaves with another write.
 */
export const SANDBOX_WRITE_TOOLS: ReadonlySet<string> = new Set([
  ...Object.keys(writeFactories),
  'batch',
]);

/**
 * Build the full sandbox handler map. Read handlers run as-is; write handlers are wrapped with
 * idempotency (same requestId applies once). `batch` calls the un-wrapped writes directly — it
 * carries one requestId and is itself idempotent, so per-op deduping would double-count.
 *
 * Wiring lives here (not in code.ts) so a registry test can enumerate the keys and assert they
 * match the server's advertised tools — a new tool can't be half-wired without a test failing.
 */
const buildHandlers = (
  figmaCtx: typeof figma,
  cache: ReturnType<typeof createIdempotencyCache>,
): SandboxHandlers => {
  const rawWrites: SandboxHandlers = Object.fromEntries(
    Object.entries(writeFactories).map(([name, create]) => [name, create(figmaCtx)]),
  );

  const handlers: SandboxHandlers = {
    ping: createPingHandler(figmaCtx),
    get_selection: createGetSelectionHandler(figmaCtx),
    get_document: createGetDocumentHandler(figmaCtx),
    get_node: createGetNodeHandler(figmaCtx),
    get_nodes_info: createGetNodesInfoHandler(figmaCtx),
    get_metadata: createGetMetadataHandler(figmaCtx),
    get_pages: createGetPagesHandler(figmaCtx),
    search_nodes: createSearchNodesHandler(figmaCtx),
    scan_text_nodes: createScanTextNodesHandler(figmaCtx),
    scan_nodes_by_types: createScanNodesByTypesHandler(figmaCtx),
    get_styles: createGetStylesHandler(figmaCtx),
    get_variable_defs: createGetVariableDefsHandler(figmaCtx),
    get_local_components: createGetLocalComponentsHandler(figmaCtx),
    get_component_api: createGetComponentApiHandler(figmaCtx),
    get_viewport: createGetViewportHandler(figmaCtx),
    get_fonts: createGetFontsHandler(figmaCtx),
    get_annotations: createGetAnnotationsHandler(figmaCtx),
    get_reactions: createGetReactionsHandler(figmaCtx),
    get_motion_styles: createGetMotionStylesHandler(figmaCtx),
    get_node_motion: createGetNodeMotionHandler(figmaCtx),
    get_motion_context: createGetMotionContextHandler(figmaCtx),
    list_files: createListFilesHandler(figmaCtx),
    get_design_context: createGetDesignContextHandler(figmaCtx),
    get_screenshot: createGetScreenshotHandler(figmaCtx),
    save_image_fills: createSaveImageFillsHandler(figmaCtx),
    export_pdf: createExportPdfHandler(figmaCtx),
    export_video: createExportVideoHandler(figmaCtx),
  };

  for (const name of Object.keys(rawWrites)) {
    handlers[name] = idempotent(cache, rawWrites[name]!);
  }
  handlers.batch = idempotent(cache, createBatchHandler(figmaCtx, rawWrites));

  return handlers;
};

export const createSandboxHandlers = (figmaApi: typeof figma): SandboxHandlers => {
  const cache = createIdempotencyCache();
  const fallback = { byIdRejected: false };
  const makeHandlers = (): SandboxHandlers => {
    const state: ReadRetryState = { used: 0, enabled: true };
    return buildHandlers(withInstanceIdLookup(figmaApi, state, fallback), cache);
  };
  // Factories bind reads to this invocation's allowance; cache and instance fallback stay session-wide.
  return Object.fromEntries(
    Object.keys(makeHandlers()).map(name => [
      name,
      (params: unknown, context: Parameters<SandboxToolHandler>[1]) =>
        makeHandlers()[name]!(params, context),
    ]),
  );
};
