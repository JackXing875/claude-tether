import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BridgeError, failure } from '../../packages/protocol/index.js';
import { probeClaude, workerEnvironment, CLAUDE_VERSION } from '../../packages/runtime-adapter/claude.js';
import type { RuntimeEvent } from '../../packages/runtime-adapter/claude.js';

const { values } = parseArgs({ options: { cwd: { type: 'string' }, claude: { type: 'string', default: 'claude' } } });
if (!values.cwd) throw new Error('Required: --cwd <private infrastructure directory>');
const cwd = resolve(values.cwd);
mkdirSync(cwd, { recursive: true, mode: 0o700 });
chmodSync(cwd, 0o700);
const summary: Record<string, unknown> = {
  expected_version: CLAUDE_VERSION, runtime: 'official CLI subprocess',
  auth_verified: false, first_turn: false, explicit_resume: false, mcp_marker_seen: false, mcp_call_seen: false,
};
try {
  const env = workerEnvironment(process.env);
  const auth = spawnSync(values.claude, ['auth', 'status', '--json'], { cwd, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  let state: { loggedIn?: boolean; authMethod?: string } = {};
  try { state = JSON.parse(auth.stdout); } catch { /* No raw diagnostic output. */ }
  if (auth.status !== 0 || state.loggedIn !== true || state.authMethod !== 'claude.ai') {
    throw new BridgeError('AUTH_REQUIRED', 'Sign in with the dedicated account using the official Claude subscription login.');
  }
  summary.auth_verified = true;
  const mcpConfig = join(cwd, 'probe-mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {
    local_bridge: { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('../mcp-bridge/probe.js', import.meta.url))] },
  } }), { mode: 0o600 });
  const runtimeId = randomUUID();
  let terminalSuccess = false;
  const events: { type: string; tools?: string[]; success?: boolean }[] = [];
  const onEvent = (event: RuntimeEvent) => {
    if (event.type === 'text') {
      if (event.text.includes('personal-relay-p0')) summary.mcp_marker_seen = true;
    } else if (event.type === 'tool') {
      if (event.name === 'mcp__local_bridge__workspace_info') summary.mcp_call_seen = true;
    } else if (event.type === 'init') events.push({ type: event.type, tools: event.tools });
    else if (event.type === 'result') { terminalSuccess = event.success; events.push({ type: 'result', success: event.success }); }
    else events.push({ type: event.type });
  };
  const context = 'This is an infrastructure-only compatibility probe. Do not read files or execute commands. Only the local_bridge workspace_info probe is available.';
  await probeClaude({
    executable: values.claude, cwd, env, signal: new AbortController().signal,
    launch: { mcpConfig, context, sessionId: runtimeId },
    prompt: 'Call the workspace_info MCP tool once, then reply with its probe marker. Do not use any other tools.', onEvent,
  });
  if (!terminalSuccess) throw new BridgeError('RUNTIME_FAILED', 'First probe turn did not succeed.');
  if (!summary.mcp_marker_seen || !summary.mcp_call_seen) throw new BridgeError('MCP_NOT_VERIFIED', 'P0 did not observe both the tool call and probe marker.');
  summary.first_turn = true; terminalSuccess = false;
  await probeClaude({
    executable: values.claude, cwd, env, signal: new AbortController().signal,
    launch: { mcpConfig, context, resumeId: runtimeId },
    prompt: 'Without calling a tool, repeat the probe marker from the previous turn.', onEvent,
  });
  if (!terminalSuccess) throw new BridgeError('RUNTIME_FAILED', 'Explicit resume probe did not succeed.');
  summary.explicit_resume = true;
  summary.events = events;
} catch (error) { summary.error = failure(error); process.exitCode = 1; }
console.log(JSON.stringify(summary, null, 2));
