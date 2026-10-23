import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BridgeError, toolNames, MAX_MESSAGE_BYTES } from '../protocol/index.js';

export const CLAUDE_VERSION = '2.1.267';
const conflictNames = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_HELPER',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_AWS',
  'CLAUDE_CODE_SIMPLE',
];
export function credentialConflicts(env: NodeJS.ProcessEnv): string[] {
  return conflictNames.filter((name) => !!env[name]);
}
export function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const conflicts = credentialConflicts(source);
  if (conflicts.length)
    throw new BridgeError(
      'AUTH_CONFIG_CONFLICT',
      'Unexpected authentication settings: ' + conflicts.join(', '),
    );
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    'HOME',
    'PATH',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'CLAUDE_CONFIG_DIR',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  result.DISABLE_AUTOUPDATER = '1';
  return result;
}
export interface LaunchConfig {
  mcpConfig: string;
  context: string;
  resumeId?: string;
  sessionId?: string;
}
export function claudeArgs(config: LaunchConfig): string[] {
  if (config.resumeId && config.sessionId)
    throw new BridgeError('INVALID_PARAMS', 'Choose resume or a new runtime session.');
  for (const value of [config.resumeId, config.sessionId]) {
    if (value && !/^[a-f0-9-]{36}$/.test(value))
      throw new BridgeError('INVALID_PARAMS', 'Runtime session must be an explicit UUID.');
  }
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    config.mcpConfig,
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--no-chrome',
    '--append-system-prompt',
    config.context,
    '--allowedTools',
    ...toolNames.map((name) => 'mcp__local_bridge__' + name),
  ];
  if (config.resumeId) args.push('--resume', config.resumeId);
  else if (config.sessionId) args.push('--session-id', config.sessionId);
  return args;
}
export function encodeUserTurn(prompt: string, sessionId?: string): string {
  return (
    JSON.stringify({
      type: 'user',
      session_id: sessionId ?? '',
      parent_tool_use_id: null,
      message: { role: 'user', content: prompt },
    }) + '\n'
  );
}
export type RuntimeEvent =
  | { type: 'init'; session_id: string; tools: string[] }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'result'; session_id: string; success: boolean }
  | { type: 'unknown'; event_type: string };

/** Pinned CLI stream contract, checked by synthetic tests and the explicit live probe. */
export class ClaudeEventDecoder {
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private initialized = false;
  private sawPartial = false;
  private sawAssistant = false;
  private finished = false;
  private runtimeSession = '';
  constructor(private readonly emit: (event: RuntimeEvent) => void) {}
  feed(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    while (this.buffer.includes('\n')) {
      const at = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES)
        throw new BridgeError('RUNTIME_PROTOCOL', 'Runtime event is too large.');
      if (line.trim()) this.line(line);
    }
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES)
      throw new BridgeError('RUNTIME_PROTOCOL', 'Runtime line is too large.');
  }
  private line(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new BridgeError('RUNTIME_PROTOCOL', 'Runtime emitted invalid JSON.');
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string')
      throw new BridgeError('RUNTIME_PROTOCOL', 'Runtime event has no type.');
    if (this.finished && ['assistant', 'stream_event', 'result'].includes(message.type)) {
      throw new BridgeError(
        'RUNTIME_PROTOCOL',
        'Runtime emitted conversation data after its terminal result.',
      );
    }
    if (message.type === 'system' && message.subtype === 'init') {
      if (this.initialized)
        throw new BridgeError('RUNTIME_PROTOCOL', 'Runtime initialized more than once.');
      const tools = message.tools;
      if (
        !Array.isArray(tools) ||
        !tools.every((tool) => typeof tool === 'string') ||
        typeof message.session_id !== 'string'
      ) {
        throw new BridgeError('RUNTIME_PROTOCOL', 'Initialization metadata is incomplete.');
      }
      const allowed = new Set(toolNames.map((name) => 'mcp__local_bridge__' + name));
      if (
        tools.some((tool) => !allowed.has(tool)) ||
        !tools.includes('mcp__local_bridge__workspace_info')
      ) {
        throw new BridgeError(
          'REMOTE_TOOL_EXPOSED',
          'Runtime tools differ from the approved local bridge set.',
        );
      }
      this.initialized = true;
      this.runtimeSession = message.session_id;
      this.emit({ type: 'init', session_id: this.runtimeSession, tools });
      return;
    }
    if (message.type === 'stream_event') {
      const event = message.event as
        { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (
        event?.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        typeof event.delta.text === 'string'
      ) {
        if (!this.initialized)
          throw new BridgeError('RUNTIME_PROTOCOL', 'Received text before initialization.');
        this.sawPartial = true;
        this.emit({ type: 'text', text: event.delta.text });
      }
      return;
    }
    if (message.type === 'assistant') {
      const content = (
        message.message as
          { content?: { type?: string; text?: string; name?: string }[] } | undefined
      )?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            if (!this.initialized)
              throw new BridgeError(
                'RUNTIME_PROTOCOL',
                'Received assistant before initialization.',
              );
            if (!this.sawPartial) this.emit({ type: 'text', text: part.text });
            this.sawAssistant = true;
          } else if (part.type === 'tool_use') {
            if (
              !this.initialized ||
              !toolNames.some((name) => part.name === 'mcp__local_bridge__' + name)
            ) {
              throw new BridgeError(
                'REMOTE_TOOL_EXPOSED',
                'Unapproved tool appeared in runtime output.',
              );
            }
            this.emit({ type: 'tool', name: part.name! });
          }
        }
      }
      this.sawPartial = false;
      return;
    }
    if (message.type === 'result') {
      if (!this.initialized || message.session_id !== this.runtimeSession || this.finished)
        throw new BridgeError('RUNTIME_PROTOCOL', 'Unexpected terminal result.');
      const success = message.is_error === false && message.subtype === 'success';
      if (!this.sawAssistant && !this.sawPartial && typeof message.result === 'string')
        this.emit({ type: 'text', text: message.result });
      this.finished = true;
      this.emit({ type: 'result', session_id: this.runtimeSession, success });
      return;
    }
    this.emit({ type: 'unknown', event_type: message.type.slice(0, 100) });
  }
  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim())
      throw new BridgeError('RUNTIME_PROTOCOL', 'Runtime ended with an incomplete NDJSON frame.');
    if (!this.finished)
      throw new BridgeError('RUNTIME_INCOMPLETE', 'Runtime exited without a confirmed result.');
  }
}

/** One-turn subprocess shared by P0 probes and the candidate supervisor. */
export async function probeClaude(options: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  launch: LaunchConfig;
  prompt: string;
  signal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new BridgeError('INVALID_PARAMS', 'Runtime timeout must be between 1 and 600000 ms.');
  const env = workerEnvironment(options.env);
  const version = spawnSync(options.executable, ['--version'], {
    env,
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (version.status !== 0 || !version.stdout.startsWith(CLAUDE_VERSION + ' ')) {
    throw new BridgeError('RUNTIME_VERSION', 'Claude version differs from the pinned P0 target.');
  }
  if (options.signal.aborted) throw new BridgeError('CANCELLED', 'Probe was cancelled.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.executable, claudeArgs(options.launch), {
      cwd: options.cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let error: unknown;
    const decoder = new ClaudeEventDecoder(options.onEvent);
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }
    };
    const timer = setTimeout(() => {
      error = new BridgeError('RUNTIME_TIMEOUT', 'P0 runtime probe timed out.');
      kill();
    }, timeoutMs);
    options.signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (bytes: Buffer) => {
      try {
        decoder.feed(bytes);
      } catch (e) {
        error = e;
        kill();
      }
    });
    child.stderr.resume(); // Do not retain authentication errors or arbitrary diagnostics verbatim.
    child.stdin.on('error', () => {
      /* Report process/terminal outcome instead of leaking a prompt. */
    });
    child.on('error', () => {
      error = new BridgeError('RUNTIME_START_FAILED', 'Could not start the official CLI.');
    });
    child.once('exit', kill); // Reap remaining MCP children in this private process group.
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', kill);
      if (options.signal.aborted)
        return reject(new BridgeError('CANCELLED', 'Probe was cancelled.'));
      if (error) return reject(error);
      try {
        decoder.end();
        if (code !== 0) throw new BridgeError('RUNTIME_EXIT', 'Runtime exited unsuccessfully.');
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(
      encodeUserTurn(options.prompt, options.launch.resumeId ?? options.launch.sessionId),
    );
  });
}
