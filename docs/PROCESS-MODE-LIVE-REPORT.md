# Process-mode real Claude validation

Recorded on 2026-10-25 (Asia/Shanghai) for the packed `0.3.0-beta.6` candidate. Both hosts used official Claude Code **2.1.310**, existing first-party Pro authentication, their existing SSH destination, and independent temporary candidate entry points. No credentials were copied. The daily installed launchers and Tether preferences were retained.

The [sanitized evidence](evidence/process-mode-live-2026-10-25.json) contains the candidate tarball hash and a manifest of the tested runtime files. The final release adds the completed reports; its archive checksum is supplied separately in the release's `SHA256SUMS`. Runtime bytes are compared against this tested candidate before publication.

## WSL CLI and official extension transport

The official Agent SDK **0.3.309** launched the official extension's **2.1.310** native Claude binary through the packaged `tether-vscode` adapter. Its dependencies and harness remain outside the production package. A temporary project contained a deliberately incorrect addition function, local assertions, a random context marker and an in-process MCP nonce fixture.

| Check | Observed result |
| --- | --- |
| Real assistant models | `claude-sonnet-5-5`, then `claude-opus-5-5` |
| Native tools | Read, Edit, Write, Bash and the local MCP tool actually ran; local assertions changed from failing to passing |
| Permissions | Default permission mode; SDK callbacks approved only the exact fixture edits, writes, Bash commands and MCP operation. No bypass mode was enabled |
| Protocol callbacks | PreToolUse hooks and bidirectional permission/control messages crossed the adapter successfully |
| Host process/watch fixture | The Bash tool observed the host fixture process and its inotify record through `tether doctor --inotify --json` |
| GPU discovery | The existing PyTorch environment reported CUDA available and one device, with no initialized PyTorch CUDA context |
| Networking | Tether reported `network: isolated`, `processes: host`; the actual tool's network namespace had no external/default route |
| Model switch | SDK `setModel('opus')` was acknowledged; the next actual response was from Opus and recalled both prior markers without tools |
| Normal EOF and cleanup | Ending SDK input closed the session; a detached temporary heartbeat tool was alive during the session and stopped after normal exit |
| Native CLI resume | A new packaged CLI invocation resumed the same session and returned both exact markers through Opus, with exit status 0 |
| Native terminal | Ctrl+C cleared unsent input without exiting Tether; `/model` opened, its menu could be cancelled, and `/exit` returned 0. No model prompt was sent in this terminal check |

The SDK transport uses the same wrapper contract and binary as the extension. **This is not a new manual acceptance of the rendered VS Code panel.** Clicks, history-picker UI, rendered diffs and editor selection were not retested for beta.6. CLI resume and SDK controls above are the verified claims.

## Native Linux / NVIDIA

The same tarball was staged in a private temporary directory on the native Linux test host; Node **24.14.0** and system Python **3.12.3** were already available. The existing daily installation remained **0.3.0-beta.5** before and after the check, and the Tether preferences hash was unchanged.

A real Sonnet response invoked one narrowly approved Bash command. That command used the host's existing **PyTorch 2.7.1+cu126 / CUDA 12.6** environment to inspect the fixture, namespace and GPU:

- Host test PID and inotify watch were visible through the candidate; the actual host `max_user_watches` was **65536**. WSL's value was **524288**, confirming the diagnostic reads the host value rather than assuming a constant.
- `/dev/nvidia0`, `/dev/nvidiactl`, `/dev/nvidia-uvm`, `/dev/nvidia-uvm-tools` and `/dev/nvidia-modeset` were present as character devices.
- CUDA discovery succeeded. The test restricted its own process to one visible GPU; it did not change host GPU visibility. `torch.cuda.is_initialized()` remained false.
- The real Bash tool ran with `network: isolated`, `processes: host`, and no external/default route. Claude exited with status 0.

The test did not allocate GPU tensors, run kernels, launch training, modify drivers or terminate existing jobs. GPU discovery is not evidence of multi-GPU collective or training correctness.

## Harness corrections and boundaries

The first native-host attempt was correctly denied by Claude's permissions: ambiguous punctuation in the test prompt made the model append a literal `.` argument, which did not match the exact allow rule. No probe ran and that attempt was not counted as a pass. The prompt was corrected to delimit the command explicitly; the next invocation executed the approved command and passed, without a Tether source change or broader permissions.

The first terminal check waited at Claude's normal new-folder trust dialog. The harness was adjusted to explicitly select trust for its own disposable fixture before testing the menu; no permission bypass was introduced.

Both host inotify reports marked the full snapshot incomplete because some process records were inaccessible or changed during the scan. The known watcher was observed successfully. These results do not claim an exact host-wide unique-watch count.

There was no deliberate real-account outage, SSH blackhole, sleep/wake test or forced termination of a generating model. IPv4/IPv6/UDP/DNS blocking, malformed upstream responses, disconnects and forced launcher termination remain covered by disposable [automated fixtures](TEST-REPORT.md). Long-duration operation, interrupted-generation recovery and account-safety guarantees are not established by this acceptance.
