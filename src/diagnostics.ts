import { createReadStream } from 'node:fs';
import { chmod, readFile, readdir, stat } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';

export interface InotifyReport {
  uid: number;
  maxUserWatches: number;
  maxUserInstances: number;
  observedWatchRecords: number;
  unreadableProcesses: number;
  unreadableFiles: number;
  incomplete: boolean;
  processes: { pid: number; name: string; watchRecords: number }[];
}

// Fixed, read-only operation. Never accept a path, command, PID or environment
// request from the isolated client. Scan only the launcher's own UID.
export async function scanInotify(signal?: AbortSignal): Promise<InotifyReport> {
  if (process.platform !== 'linux' || !process.getuid) throw new Error('Inotify diagnostics require Linux.');
  const deadline = AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]);
  const limit = async (name: string) => Number((await readFile(`/proc/sys/fs/inotify/${name}`, { encoding: 'utf8', signal: deadline })).trim());
  const [maxUserWatches, maxUserInstances] = await Promise.all([limit('max_user_watches'), limit('max_user_instances')]);
  const report: InotifyReport = { uid: process.getuid(), maxUserWatches, maxUserInstances,
    observedWatchRecords: 0, unreadableProcesses: 0, unreadableFiles: 0, incomplete: false, processes: [] };
  const missing = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    if (deadline.aborted) { report.incomplete = true; break; }
    let name: string, files: string[];
    try {
      if ((await stat(`/proc/${pid}`)).uid !== report.uid) continue;
      name = (await readFile(`/proc/${pid}/comm`, { encoding: 'utf8', signal: deadline })).trim();
      files = await readdir(`/proc/${pid}/fdinfo`);
    } catch (error) {
      if (!missing(error)) report.unreadableProcesses++;
      continue;
    }
    let watchRecords = 0;
    for (const fd of files) {
      if (deadline.aborted) { report.incomplete = true; break; }
      const input = createReadStream(`/proc/${pid}/fdinfo/${fd}`, { signal: deadline });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) if (line.startsWith('inotify ')) watchRecords++;
      } catch (error) { if (!missing(error)) report.unreadableFiles++; }
      finally { lines.close(); input.destroy(); }
    }
    report.observedWatchRecords += watchRecords;
    if (watchRecords) {
      if (report.processes.length < 4_096) report.processes.push({ pid: Number(pid), name, watchRecords });
      else report.incomplete = true;
    }
  }
  report.incomplete ||= deadline.aborted || report.unreadableProcesses > 0 || report.unreadableFiles > 0;
  report.processes.sort((a, b) => b.watchRecords - a.watchRecords || a.pid - b.pid);
  return report;
}

const maxReply = 2 * 1024 * 1024;

export async function startHostDiagnostics(path: string) {
  const sockets = new Set<Socket>();
  const abort = new AbortController();
  let scan: Promise<InotifyReport> | undefined;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(7_000, () => socket.destroy());
    if (sockets.size > 8) { socket.destroy(); return; }
    let request = '', handled = false;
    socket.on('data', data => {
      if (handled) { socket.destroy(); return; }
      request += data.toString('utf8');
      if (!'inotify\n'.startsWith(request)) { socket.end('{"error":"Unsupported diagnostic"}\n'); handled = true; return; }
      if (request !== 'inotify\n') return;
      handled = true;
      scan ??= scanInotify(abort.signal).finally(() => { scan = undefined; });
      void scan.then(report => {
        const reply = JSON.stringify(report) + '\n';
        socket.end(Buffer.byteLength(reply) <= maxReply ? reply : '{"error":"Diagnostic response too large"}\n');
      }, () => socket.end('{"error":"Host diagnostic unavailable"}\n'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  try { await chmod(path, 0o600); }
  catch (error) { server.close(); throw error; }
  return { close: async () => {
    abort.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await scan?.catch(() => {});
  } };
}

export async function inotifyDiagnostic(env: NodeJS.ProcessEnv = process.env): Promise<InotifyReport> {
  if (env.TETHER_NETWORK_MODE !== 'isolated') return scanInotify();
  const path = env.TETHER_HOST_SOCKET;
  if (env.TETHER_PROCESS_MODE !== 'host' || !path) {
    throw new Error('Host inotify diagnostics are unavailable in this session. Run tether doctor --inotify in a host terminal, or restart Tether with --processes host.');
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let reply = '';
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(8_000, () => fail(new Error('Host diagnostic timed out.')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write('inotify\n'));
    socket.on('data', data => {
      reply += data.toString('utf8');
      if (Buffer.byteLength(reply) > maxReply) fail(new Error('Host diagnostic response too large.'));
    });
    socket.on('end', () => {
      try {
        const report = JSON.parse(reply) as InotifyReport & { error?: string };
        if (report.error) throw new Error(report.error);
        if (!Array.isArray(report.processes) || !Number.isSafeInteger(report.observedWatchRecords)) throw new Error('Invalid host diagnostic response.');
        resolve(report);
      } catch (error) { fail(error as Error); }
    });
    socket.on('close', () => reject(new Error('Host diagnostic connection closed.')));
  });
}

export function formatInotify(report: InotifyReport): string {
  const rows = report.processes.map(p => `${p.watchRecords}\t${p.pid}\t${JSON.stringify(p.name)}`);
  return [`Host inotify diagnostics (UID ${report.uid})`, 'WATCH RECORDS\tPID\tNAME', ...rows,
    `Observed watch records: ${report.observedWatchRecords}`,
    `max_user_watches: ${report.maxUserWatches}; max_user_instances: ${report.maxUserInstances}`,
    `Unreadable processes: ${report.unreadableProcesses}; unreadable fdinfo files: ${report.unreadableFiles}; incomplete: ${report.incomplete}`,
    'Current-user snapshot only. Shared/inherited descriptors may be counted more than once; this is not a count of unique watches.'].join('\n');
}
