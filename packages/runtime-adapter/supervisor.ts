import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { bindingSchema, BridgeError, id, toolNames } from '../protocol/index.js';
import { ensurePrivateDirectory } from '../config/index.js';
import { RuntimeChannel } from '../runtime-channel/index.js';
import { RuntimeSessionStore } from './session-store.js';
import { probeClaude, workerEnvironment } from './claude.js';
import type { AgentRuntime, RuntimeTurn } from './types.js';

export interface ClaudeRuntimeOptions {
  executable: string;
  stateDirectory: string;
  /** Application-supplied absolute path; core packages never import an application. */
  mcpWorkerPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Official CLI supervisor with explicit conversation identity and locally authorized tools. */
export class ClaudeRuntime implements AgentRuntime {
  readonly kind = 'claude' as const;
  private readonly root: string;
  private readonly sessions: RuntimeSessionStore;
  private active?: { controller: AbortController; done: Promise<void> };
  private closing?: Promise<void>;
  constructor(private readonly options: ClaudeRuntimeOptions) {
    if (process.platform !== 'linux')
      throw new BridgeError(
        'UNSUPPORTED_PLATFORM',
        'The candidate runtime requires Linux process groups.',
      );
    if (!isAbsolute(options.mcpWorkerPath))
      throw new BridgeError('INVALID_CONFIG', 'Use an absolute installed MCP worker path.');
    this.root = ensurePrivateDirectory(options.stateDirectory);
    this.sessions = new RuntimeSessionStore(join(this.root, 'runtime.sqlite'));
  }
  run(turn: RuntimeTurn): Promise<void> {
    if (this.closing) return Promise.reject(new BridgeError('CANCELLED', 'Runtime is closed.'));
    if (this.active)
      return Promise.reject(
        new BridgeError('SESSION_BUSY', 'Only one official CLI turn can run at a time.'),
      );
    const controller = new AbortController();
    const bound = {
      ...turn,
      binding: bindingSchema.parse(turn.binding),
      turnId: id.parse(turn.turnId),
    };
    const done = this.perform(bound, AbortSignal.any([turn.signal, controller.signal]));
    this.active = { controller, done };
    return done.finally(() => {
      this.active = undefined;
    });
  }
  private async perform(turn: RuntimeTurn, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new BridgeError('CANCELLED', 'Runtime turn was cancelled.');
    const env = workerEnvironment(this.options.env ?? process.env);
    const auth = spawnSync(this.options.executable, ['auth', 'status', '--json'], {
      cwd: this.root,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    let authorized = false;
    try {
      const value = JSON.parse(auth.stdout) as { loggedIn?: unknown; authMethod?: unknown };
      authorized = auth.status === 0 && value.loggedIn === true && value.authMethod === 'claude.ai';
    } catch {
      /* Never forward authentication output. */
    }
    if (!authorized)
      throw new BridgeError(
        'AUTH_REQUIRED',
        'Sign in using the dedicated VPS account and official Claude subscription login.',
      );
    if (signal.aborted) throw new BridgeError('CANCELLED', 'Runtime turn was cancelled.');
    const session = this.sessions.begin(turn.binding);
    let channel: RuntimeChannel | undefined;
    let temporary: string | undefined;
    let success = false;
    const disconnected = new AbortController();
    const stopTools = () => turn.cancelTools();
    signal.addEventListener('abort', stopTools, { once: true });
    try {
      const cwd = ensurePrivateDirectory(join(this.root, 'sessions', session.runtimeId));
      temporary = mkdtempSync(join(cwd, 'turn-'));
      channel = new RuntimeChannel({
        binding: turn.binding,
        turnId: turn.turnId,
        signal,
        execute: turn.execute,
        disconnected: () => {
          disconnected.abort();
          turn.cancelTools();
        },
      });
      const config = await channel.listen();
      const channelPath = join(temporary, 'channel.json');
      writeFileSync(channelPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
      const mcpConfig = join(temporary, 'mcp.json');
      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            local_bridge: {
              type: 'stdio',
              command: process.execPath,
              args: [this.options.mcpWorkerPath, '--channel', channelPath],
            },
          },
        }),
        { mode: 0o600, flag: 'wx' },
      );
      await probeClaude({
        executable: this.options.executable,
        cwd,
        env,
        signal: AbortSignal.any([signal, disconnected.signal]),
        timeoutMs: this.options.timeoutMs,
        launch: {
          mcpConfig,
          ...(session.resume ? { resumeId: session.runtimeId } : { sessionId: session.runtimeId }),
          context:
            'You are running on a remote infrastructure server. The project, files and command environment are on the connected LOCAL device. Use only local_bridge tools. Call workspace_info to learn the actual execution target. Do not infer project paths or programs from the remote cwd. Every local mutation requires local permission. Tool failures and UNKNOWN outcomes must not be retried automatically.',
        },
        prompt: turn.prompt,
        onEvent: (event) => {
          if (event.type === 'init') {
            if (
              event.session_id !== session.runtimeId ||
              new Set(event.tools).size !== toolNames.length
            )
              throw new BridgeError(
                'RUNTIME_PROTOCOL',
                'Runtime did not initialize the expected session and complete local tool set.',
              );
            this.sessions.initialized(turn.binding.session_id);
            channel!.activate();
          } else if (event.type === 'text') turn.text(event.text);
          else if (event.type === 'result') success = event.success;
        },
      });
      if (!success)
        throw new BridgeError('RUNTIME_FAILED', 'Official CLI did not confirm a successful turn.');
    } catch (error) {
      success = false;
      throw error;
    } finally {
      signal.removeEventListener('abort', stopTools);
      turn.cancelTools();
      try {
        await channel?.close();
      } finally {
        if (temporary) rmSync(temporary, { recursive: true, force: true });
        this.sessions.finish(turn.binding.session_id, success);
      }
    }
  }
  close(): Promise<void> {
    return (this.closing ??= this.shutdown());
  }
  private async shutdown(): Promise<void> {
    this.active?.controller.abort();
    await this.active?.done.catch(() => {});
    this.sessions.close();
  }
}
