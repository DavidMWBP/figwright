# @figwright/mcp

> The MCP server for **[Figwright](https://github.com/awdr74100/figwright)**: a two-way Figma agent for Claude Code, Cursor, Codex, and other MCP clients.

Figwright bridges MCP clients to a Figma plugin over a local WebSocket relay, so an AI agent can both **read** your designs with high-fidelity grounding and **write** back to the canvas. No Figma paid tier required. The server exposes **123 tools** spanning reads, writes, and codebase-grounded context.

## Usage

Add it to your MCP client config (e.g. Claude Code's `.mcp.json`):

```json
{
  "mcpServers": {
    "figwright": {
      "command": "npx",
      "args": ["-y", "@figwright/mcp@latest"]
    }
  }
}
```

The server talks to the Figwright Figma plugin running in your Figma app. See the [main repository](https://github.com/awdr74100/figwright) for the full setup (installing the plugin, connecting, and the available skills).

Start it from **Plugins → Development → Figwright**. After it runs in a Figma Design file, **Run Figwright** appears in the right-hand properties panel with nothing selected, on every page, and starts it again like the menu. Repeated starts save the same single button. Registration is skipped in FigJam and Dev Mode; if file permissions reject saving it, startup still works through the plugins menu.

For file targeting, `list_files` lists connected files and `use_file` claims one. `open_file` takes a file key or figma.com file/design URL, asks the OS URL opener to open it, waits for the plugin, and claims it. The plugin must already run in that file, or you must start it there. Desktop URL handling (`figma://design/<key>`) was verified live on Windows on 2026-10-11; macOS (`open`) and Linux (`xdg-open`) have not been live-checked. Pass `fileName` to match the exact name (duplicates are refused); otherwise it claims the first newly connected session. The wait defaults to 120 seconds (`timeoutSec`, maximum 600). It returns `{ ok: true, opened, sessionId, fileName, claim }`, and failures leave the current claim unchanged.

## Requirements

- Node.js 20.19+ or 22.12+ (the server runs via `npx` as its own process, independent of your project's Node version)

## Links

- Repository & docs: https://github.com/awdr74100/figwright
- Issues: https://github.com/awdr74100/figwright/issues

## License

[MIT](https://github.com/awdr74100/figwright/blob/main/LICENSE)
