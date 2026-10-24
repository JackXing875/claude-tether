# VS Code extension

Tether can launch the official Claude Code extension's bundled CLI through the same SSH transport and network isolation as the terminal launcher. The native chat panel remains responsible for conversations, model selection, editor context, diffs and permission prompts.

## Linux and Remote WSL setup

1. Install Tether and run `tether setup my-vps` in the Linux environment where the extension runs. Confirm `tether doctor` succeeds.
2. Install the official `anthropic.claude-code` extension in that environment. On Windows, open the project in a **Remote WSL** window and install the extension in WSL.
3. Run `command -v tether-vscode` and copy the absolute path. Add these settings to VS Code's **Remote [WSL] settings** (or user settings on Linux):

   ```json
   {
     "claudeCode.claudeProcessWrapper": "/absolute/path/to/tether-vscode",
     "claudeCode.useTerminal": false
   }
   ```

4. Reload the VS Code window and open Claude's native panel. Check the account displayed there before making a request. The Claude Code output channel shows `[tether] SSH tunnel ready` and `Network: isolated` when the adapter starts.

The npm entry point uses `node` from the extension host's PATH. If Node is installed through a shell version manager and VS Code cannot find it, use a small executable script with absolute paths:

```sh
#!/bin/sh
exec /absolute/path/to/node /absolute/path/to/claude-tether/dist/src/vscode.js "$@"
```

Point `claudeCode.claudeProcessWrapper` at that script. Do not point it at `tether`, a terminal alias, or a wrapper that appends every argument after `--`: the extension supplies its **bundled Claude executable as argument one**. `tether-vscode` selects that executable with `--claude` and passes the remaining SDK arguments literally. This also follows the extension's binary path after an extension update.

The adapter shares Tether's saved preferences, working directory and environment. It keeps stdin/stdout available for the bidirectional SDK protocol and writes diagnostics only to stderr. It preserves exit status and cancellation and uses the same reconnect/cleanup behavior as the terminal launcher. It does not patch the official extension or bypass its permissions.

## An existing separate Pro profile

If your terminal launcher sets `CLAUDE_CONFIG_DIR` and `XDG_CONFIG_HOME`, the extension needs the same profile and Tether preferences. Add these entries to the existing `claudeCode.environmentVariables` array, preserving unrelated entries:

```json
"claudeCode.environmentVariables": [
  { "name": "CLAUDE_CONFIG_DIR", "value": "/absolute/path/to/pro/claude" },
  { "name": "XDG_CONFIG_HOME", "value": "/absolute/path/to/pro/xdg" }
]
```

Run setup with that same `XDG_CONFIG_HOME` first. If your personal launcher clears conflicting API keys or provider variables, apply the same policy in a dedicated VS Code wrapper and its environment settings. Tether itself does not choose an authentication or billing method. Keep credentials in the official profile; never place tokens in VS Code workspace settings. See the [Pro profile instructions](RUNBOOK.md#separating-a-personal-pro-login).

## Network and feature boundaries

- The bundled Claude process and its Linux child tools use isolated networking through the configured VPS. Overriding proxy variables does not restore a direct external route.
- **The VS Code extension host is outside this namespace.** Requests that the extension itself makes, such as account refresh, Web-session listing, dictation or telemetry, are not covered by the process wrapper. `http.proxy` or environment settings alone are not proof of complete egress isolation. This integration does not route all VS Code traffic through Tether.
- The native panel's SDK callbacks and in-process MCP tools communicate over stdio. They do not require opening arbitrary host loopback access. Operations performed by VS Code or an SDK-side tool run in that host's context, not in Claude's namespace.
- The CLI's separate `/ide` WebSocket connection, host Jupyter kernels, host-local HTTP MCP servers and browser callbacks remain subject to the [host-loopback restrictions](NETWORK.md). This adapter does not add a general loopback bridge. Use the native panel for this integration; terminal IDE attachment is separate work.
- Windows native VS Code cannot execute the Linux adapter. Use Remote WSL. macOS and Windows native proxy compatibility are not validated here.
- Official wrapper behavior also skips the extension's concurrent-session check and automatic restoration of a resumed plan-mode session. Avoid opening one session for editing in multiple clients at once.

## Verification and troubleshooting

Open a project in the WSL window, start a new panel conversation, ask Claude to read a small file, review an edit, and select a model from the panel. If it cannot start, inspect the Claude Code output channel for a missing Node runtime, wrong executable path, or SSH/isolation failure. An already-running conversation keeps its old process; close and reopen it after a Tether update.

GPU compute does not require disabling network isolation. Tether exposes supported GPU device nodes while retaining its private network namespace. See [GPU access](NETWORK.md#gpu-access).

The [validation record](VSCODE-LIVE-REPORT.md) distinguishes real SDK/Claude tests from desktop UI checks. To undo the integration, remove `claudeCode.claudeProcessWrapper` and only the environment entries you added, then reload the window. The ordinary extension will then launch its own CLI without Tether.

References: [official extension settings](https://code.claude.com/docs/en/vs-code#extension-settings), [IDE MCP transport](https://code.claude.com/docs/en/vs-code#the-built-in-ide-mcp-server), [Remote WSL](https://code.visualstudio.com/docs/remote/wsl).
