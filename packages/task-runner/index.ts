import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BridgeError, MAX_OUTPUT_BYTES } from '../protocol/index.js';

export interface CommandResult {
  stdout: string; stderr: string; exit_code: number | null; signal: string | null;
  truncated: boolean; cancelled: boolean; timed_out: boolean;
}

/** Foreground exec only. No hidden shell, env overlay, PTY or background mode. */
export function runCommand(
  input: { program: string; args: string[]; timeout_ms: number },
  cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal,
): Promise<CommandResult> {
  if (process.platform === 'win32') {
    throw new BridgeError('UNSUPPORTED_CAPABILITY', 'Native Windows process trees are not implemented yet.');
  }
  if (signal.aborted) throw new BridgeError('CANCELLED', 'Operation was cancelled before execution.');
  return new Promise((resolve, reject) => {
    const child = spawn(input.program, input.args, {
      cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const buffers = { stdout: '', stderr: '' };
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let retained = 0, truncated = false, cancelled = false, timedOut = false, settled = false;
    let escalation: NodeJS.Timeout | undefined;
    const killGroup = (kind: NodeJS.Signals) => {
      if (child.pid) {
        try { process.kill(-child.pid, kind); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      }
    };
    const stop = () => {
      if (cancelled) return;
      cancelled = true;
      killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), 300);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, input.timeout_ms);
    signal.addEventListener('abort', stop, { once: true });
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (bytes: Buffer) => {
        const remaining = Math.max(0, MAX_OUTPUT_BYTES - retained);
        if (bytes.length > remaining) truncated = true;
        const piece = bytes.subarray(0, remaining);
        retained += piece.length;
        buffers[stream] += decoders[stream].write(piece);
      });
    }
    const cleanup = () => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal.removeEventListener('abort', stop);
    };
    child.on('error', () => {
      if (settled) return;
      settled = true; cleanup();
      reject(new BridgeError('PROCESS_START_FAILED', 'The local executable could not be started.'));
    });
    child.on('close', (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      // Foreground-only contract: disallow surviving same-group background children.
      killGroup('SIGKILL');
      cleanup();
      buffers.stdout += decoders.stdout.end();
      buffers.stderr += decoders.stderr.end();
      resolve({
        ...buffers, exit_code: exitCode, signal: exitSignal,
        truncated, cancelled, timed_out: timedOut,
      });
    });
  });
}
