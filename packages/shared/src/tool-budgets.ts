// Single source of truth for per-tool timeout budgets, shared by every layer that waits on a tool
// call. A request crosses up to three independent timers, nested outer→inner:
//
//   follower → leader RPC      (follower.ts)        ← outermost, only on multi-node
//     └─ relay → plugin request (relay.ts)
//          └─ UI → sandbox bridge (ui/bridge/sandbox.ts)  ← innermost, closest to the work
//
// If any inner timer is ≥ an outer one, the outer fires first and leaves the inner layer orphaned
// (its work keeps running, its result is later discarded) and reports a vaguer error. So each layer
// must be strictly larger than the one it wraps. We derive all three from one base budget `B` plus a
// per-layer margin, so the innermost (sandbox) always fires first with the most specific error.
//
// Raising any subset in isolation does nothing: the smallest timer along the path caps the call. In
// particular the sandbox bridge defaulted to 30s for every tool, so before this table a heavy tool
// timed out there regardless of the relay/follower budgets. This lives in @figwright/shared precisely
// so the plugin UI (which can't import the mcp package's ToolSpec) reads the same numbers.

export const DEFAULT_TOOL_BUDGET_MS = 30_000;

// Tools whose Figma-side work — large synchronous serialization, a big export payload, or a
// per-instance async walk over a large tree — routinely exceeds the default window.
export const HEAVY_TOOL_BUDGET_MS = 120_000;

// Gap added per nesting layer (relay = B + 1×, follower = B + 2×) so inner fires before outer.
export const BUDGET_LAYER_MARGIN_MS = 5_000;

const HEAVY_TOOLS: ReadonlySet<string> = new Set([
  'get_screenshot',
  'save_screenshots',
  'save_image_fills',
  'export_pdf',
  'get_document',
  'get_design_context',
  // Full recursive subtree serialization with no depth limit or dedupe (per mixed TEXT a
  // getStyledTextSegments call, per INSTANCE an async main-component resolve) — on a large frame
  // this is at least as heavy as get_design_context, which already has the wide budget.
  'get_node',
  'get_nodes_info',
  // Page-wide walks: every node in scope is visited, then each match serialized with a
  // main-component lookup per instance — a 32k-instance page measured ~24s warm and ~36–41s cold.
  // The result budget now caps how much is serialized, not how far the walk goes. search_nodes
  // does the same work as the scans and, left on the default, timed out at 35s on 16k instances.
  'search_nodes',
  'scan_text_nodes',
  'scan_nodes_by_types',
  // Component catalogues also scan a whole subtree. A cold library page in a background file
  // exceeded the default sandbox window before its native component scan could return.
  'get_local_components',
  // A library import resolves the library inside Figma, and in a background file that work can wait
  // on Figma's own throttled timers: a background tab was measured delaying a zero-delay timer by
  // close to a minute, and first-time resolution there was seen to outlast the default window. This
  // is inferred from those, not measured on an import (no published library was at hand). The wide
  // window lets a background import finish instead of timing out while Figma is still importing.
  'import_variable',
  'import_style',
]);

/** Base budget `B`: how long the Figma sandbox itself may take. Used by the UI → sandbox bridge. */
// Batch gets the existing 120s base plus 10s per op, capped at 10 minutes (48 ops).
// The base leaves room for capture and rollback; growth accommodates sequential writes without
// letting an unbounded op list create an unbounded wait. This is a budget, not an API latency bound.
// Reserve 60s for unwind: a single font-loading undo has taken about 49s. Multiple or stuck undos
// can still exhaust it, so the UI reports progress and an unknown outcome rather than success.
export const BATCH_ROLLBACK_RESERVE_MS = 60_000;
export const getToolBudget = (toolName: string, params?: unknown): number => {
  if (toolName === 'batch') {
    const ops = (params as { ops?: unknown } | null)?.ops;
    return Math.min(600_000, 120_000 + (Array.isArray(ops) ? ops.length : 0) * 10_000);
  }
  return HEAVY_TOOLS.has(toolName) ? HEAVY_TOOL_BUDGET_MS : DEFAULT_TOOL_BUDGET_MS;
};

/** Relay → plugin request budget = B + one margin, so the sandbox bridge (inner) fires first. */
export const getRelayBudget = (toolName: string, params?: unknown): number =>
  getToolBudget(toolName, params) + BUDGET_LAYER_MARGIN_MS;

/** Follower → leader RPC budget = B + two margins, the outermost layer on the multi-node path. */
export const getFollowerBudget = (toolName: string, params?: unknown): number =>
  getToolBudget(toolName, params) + 2 * BUDGET_LAYER_MARGIN_MS;
