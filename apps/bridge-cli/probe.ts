import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { BridgeError, failure } from '../../packages/protocol/index.js';
import { ensurePrivateDirectory } from '../../packages/config/index.js';
import {
  probeClaude,
  workerEnvironment,
  CLAUDE_VERSION,
} from '../../packages/runtime-adapter/claude.js';
import { ProbeTurnEvidence } from '../../packages/runtime-adapter/probe-evidence.js';

export async function runProbe(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { cwd: { type: 'string' }, claude: { type: 'string', default: 'claude' } },
  });
  if (!values.cwd)
    throw new BridgeError('USAGE', 'Required: --cwd <private infrastructure directory>');
  const parent = ensurePrivateDirectory(values.cwd);
  const cwd = mkdtempSync(join(parent, 'p0-'));
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const summary: Record<string, unknown> = {
    expected_version: CLAUDE_VERSION,
    runtime: 'official CLI subprocess',
    auth_verified: false,
    first_turn: false,
    explicit_resume: false,
    mcp_marker_seen: false,
    mcp_call_seen: false,
    resumed_marker_seen: false,
  };
  try {
    const env = workerEnvironment(process.env);
    const auth = spawnSync(values.claude, ['auth', 'status', '--json'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    let state: { loggedIn?: boolean; authMethod?: string } = {};
    try {
      state = JSON.parse(auth.stdout);
    } catch {
      /* No raw diagnostic output. */
    }
    if (auth.status !== 0 || state.loggedIn !== true || state.authMethod !== 'claude.ai') {
      throw new BridgeError(
        'AUTH_REQUIRED',
        'Sign in with the dedicated account using the official Claude subscription login.',
      );
    }
    summary.auth_verified = true;
    const challengePath = join(cwd, 'challenge.json');
    const marker = 'p0-' + randomBytes(16).toString('hex');
    writeFileSync(challengePath, JSON.stringify({ marker }), { mode: 0o600, flag: 'wx' });
    const mcpConfig = join(cwd, 'probe-mcp.json');
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          local_bridge: {
            type: 'stdio',
            command: process.execPath,
            args: [
              fileURLToPath(new URL('../mcp-bridge/probe.js', import.meta.url)),
              '--challenge',
              challengePath,
            ],
          },
        },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    const runtimeId = randomUUID();
    const context =
      'This is an infrastructure-only compatibility probe. Do not read files or execute commands. Only the local_bridge workspace_info probe is available.';
    const first = new ProbeTurnEvidence(runtimeId, marker, 'first');
    await probeClaude({
      executable: values.claude,
      cwd,
      env,
      signal: controller.signal,
      launch: { mcpConfig, context, sessionId: runtimeId },
      prompt:
        'Call the workspace_info MCP tool once, then reply with its exact probe marker. Do not use any other tools.',
      onEvent: (event) => first.accept(event),
    });
    const evidence = first.finish();
    summary.first_turn = true;
    summary.mcp_marker_seen = evidence.marker_seen;
    summary.mcp_call_seen = evidence.tool_call_seen;

    // The old marker exists only in the previous conversation, not in the next prompt or tool.
    writeFileSync(
      challengePath,
      JSON.stringify({ marker: 'p0-' + randomBytes(16).toString('hex') }),
    );
    const resumed = new ProbeTurnEvidence(runtimeId, marker, 'resume');
    await probeClaude({
      executable: values.claude,
      cwd,
      env,
      signal: controller.signal,
      launch: { mcpConfig, context, resumeId: runtimeId },
      prompt:
        'Without calling a tool, repeat the exact probe marker returned in the previous turn.',
      onEvent: (event) => resumed.accept(event),
    });
    summary.resumed_marker_seen = resumed.finish().marker_seen;
    summary.explicit_resume = true;
  } catch (error) {
    summary.error = failure(error);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    rmSync(cwd, { recursive: true, force: true });
  }
  console.log(JSON.stringify(summary, null, 2));
}
