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

Run `tether update` in the environment containing that installation to upgrade both terminal and VS Code entry points. The updater keeps their paths and your extension settings intact; reopen the Claude conversation to use the new code. Custom wrappers should point at the same stable package location. It does not update the official VS Code extension itself.

## An existing separate Pro profile

If your terminal launcher sets `CLAUDE_CONFIG_DIR` and `XDG_CONFIG_HOME`, the extension needs the same profile and Tether preferences. Add these entries to the existing `claudeCode.environmentVariables` array, preserving unrelated entries:

```json
"claudeCode.environmentVariables": [
  { "name": "CLAUDE_CONFIG_DIR", "value": "/absolute/path/to/pro/claude" },
  { "name": "XDG_CONFIG_HOME", "value": "/absolute/path/to/pro/xdg" }
]
```

Run setup with that same `XDG_CONFIG_HOME` first. If your personal launcher clears conflicting API keys or provider variables, apply the same policy in a dedicated VS Code wrapper and its environment settings. Tether itself does not choose an authentication or billing method. Keep credentials in the official profile; never place tokens in VS Code workspace settings. See the [Pro profile instructions](RUNBOOK.md#separating-a-personal-pro-login).

### Empty history with a separate profile

The extension's history picker reads session files in the **extension host**, before a Claude process is launched. `claudeCode.environmentVariables` and a shell wrapper set the child's environment; they do not set the extension host's own environment. In the inspected official extension 2.1.310, using `claudeProcessWrapper` also prevents the picker from adopting the `configDirectory` reported by `claude auth status`. Chat can therefore work while the history picker still searches the default `~/.claude/projects` instead of the separate profile.

Set `CLAUDE_CONFIG_DIR` to the same absolute directory in the environment that starts the extension host. For Remote WSL, add the following to the existing `~/.vscode-server/server-env-setup`, preserving any other setup:

```sh
export CLAUDE_CONFIG_DIR='/absolute/path/to/pro/claude'
```

This is VS Code's [documented WSL server environment setup](https://code.visualstudio.com/docs/remote/wsl#_advanced-environment-setup-script). The file must be valid Bourne shell syntax. It is read when the WSL VS Code Server starts, so restart that server after saving work; reloading only a window can retain the old server environment. The variable applies to that WSL server's extension hosts and newly inherited child environments, not to unrelated login shells. Keep `XDG_CONFIG_HOME` scoped to the existing Claude wrapper/settings unless the whole VS Code server deliberately uses that XDG profile.

Once the host and launcher agree, reopen the project and its history picker. Existing transcripts stay in their original profile. This selects that profile's history; it does not merge conversations from other accounts, profiles, machines or projects. A normal Linux VS Code launch needs the equivalent variable in its application environment; Remote SSH needs it in that remote extension host's environment.

## Network and feature boundaries

- The bundled Claude process and its Linux child tools use isolated networking through the configured VPS. Overriding proxy variables does not restore a direct external route.
- **The VS Code extension host is outside this namespace.** Requests that the extension itself makes, such as account refresh, Web-session listing, dictation or telemetry, are not covered by the process wrapper. `http.proxy` or environment settings alone are not proof of complete egress isolation. This integration does not route all VS Code traffic through Tether.
- The native panel's SDK callbacks and in-process MCP tools communicate over stdio. They do not require opening arbitrary host loopback access. Operations performed by VS Code or an SDK-side tool run in that host's context, not in Claude's namespace.
- The CLI's separate `/ide` WebSocket connection, host Jupyter kernels, host-local HTTP MCP servers and browser callbacks remain subject to the [host-loopback restrictions](NETWORK.md). This adapter does not add a general loopback bridge. Use the native panel for this integration; terminal IDE attachment is separate work.
- Windows native VS Code cannot execute the Linux adapter. Use Remote WSL. macOS and Windows native proxy compatibility are not validated here.
- Official wrapper behavior also skips the extension's concurrent-session check and automatic restoration of a resumed plan-mode session. Avoid opening one session for editing in multiple clients at once.

## Verification and troubleshooting

Open a project in the WSL window, start a new panel conversation, ask Claude to read a small file, review an edit, and select a model from the panel. If it cannot start, inspect the Claude Code output channel for a missing Node runtime, wrong executable path, or SSH/isolation failure. An already-running conversation keeps its old process; close and reopen it after a Tether update.

If new chats work but history is empty, check the [separate-profile history setup](#empty-history-with-a-separate-profile) before changing SSH or copying session files. An empty picker can be a host/child profile mismatch even when the CLI itself can resume the conversation.

GPU compute does not require disabling network isolation. Tether exposes supported GPU device nodes while retaining its private network namespace. See [GPU access](NETWORK.md#gpu-access).

The [validation record](VSCODE-LIVE-REPORT.md) distinguishes real SDK/Claude tests from desktop UI checks. To undo the integration, remove `claudeCode.claudeProcessWrapper` and only the environment entries you added, then reload the window. The ordinary extension will then launch its own CLI without Tether.

References: [official extension settings](https://code.claude.com/docs/en/vs-code#extension-settings), [IDE MCP transport](https://code.claude.com/docs/en/vs-code#the-built-in-ide-mcp-server), [Remote WSL](https://code.visualstudio.com/docs/remote/wsl).
