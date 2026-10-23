import { once } from 'node:events';
import { Agent, createServer, request, type IncomingHttpHeaders } from 'node:http';
import { createConnection, type Socket } from 'node:net';

// Paused reads preserve bytes arriving alongside the final SOCKS reply.
async function readBytes(socket: Socket, size: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = size;
  while (remaining > 0) {
    if (socket.readableLength > 0) {
      const chunk = socket.read(Math.min(remaining, socket.readableLength)) as Buffer;
      chunks.push(chunk);
      remaining -= chunk.length;
      continue;
    }
    if (socket.destroyed || socket.readableEnded) throw new Error('SOCKS connection closed');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off('readable', ready).off('error', failed).off('end', ended).off('close', ended);
      };
      const ready = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const ended = () => failed(new Error('SOCKS connection closed'));
      socket.once('readable', ready).once('error', failed).once('end', ended).once('close', ended);
    });
  }
  return Buffer.concat(chunks, size);
}

export async function openSocks(port: number, signal: AbortSignal): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port, signal });
  socket.on('error', () => {}); // Also covers cancellation between awaited reads.
  try {
    await once(socket, 'connect');
    socket.write(Buffer.from([5, 1, 0]));
    const reply = await readBytes(socket, 2);
    if (reply[0] !== 5 || reply[1] !== 0) throw new Error('SOCKS authentication failed');
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

export async function connectSocks(socksPort: number, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  const socket = await openSocks(socksPort, signal);
  try {
    const name = Buffer.from(host, 'ascii');
    if (!name.length || name.length > 255) throw new Error('Invalid destination');
    const request = Buffer.alloc(7 + name.length);
    request.set([5, 1, 0, 3, name.length]);
    name.copy(request, 5); // Domain form: DNS resolution happens at the VPS.
    request.writeUInt16BE(port, 5 + name.length);
    socket.write(request);
    const reply = await readBytes(socket, 4);
    if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error('SOCKS destination unavailable');
    const size = reply[3] === 1 ? 4 : reply[3] === 4 ? 16
      : reply[3] === 3 ? (await readBytes(socket, 1))[0]! : 0;
    if (!size) throw new Error('Invalid SOCKS reply');
    await readBytes(socket, size + 2);
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

export type Dial = (host: string, port: number, signal: AbortSignal) => Promise<Socket>;

function forwardedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const hopHeaders = ['connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    ...(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())];
  for (const key of hopHeaders) delete result[key];
  return result;
}

export async function startProxy(dial: Dial) {
  const sockets = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 15_000, requestTimeout: 0 }, (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      if (target.protocol !== 'http:' || target.username || target.password || target.hash) throw new Error();
    } catch {
      res.writeHead(400, { Connection: 'close' }).end('Absolute HTTP URL or HTTPS CONNECT required\n');
      return;
    }
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    req.once('aborted', () => controller.abort());
    void (async () => {
      let agent: Agent | undefined;
      try {
        const socket = await dial(target.hostname.replace(/^\[|\]$/g, ''), Number(target.port || 80), controller.signal);
        if (controller.signal.aborted) { socket.destroy(); return; }
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        agent = new Agent({ keepAlive: false });
        agent.createConnection = () => socket;
        const upstream = request(target, { method: req.method, agent, signal: controller.signal,
          headers: { ...forwardedHeaders(req.headers), host: target.host } }, response => {
          res.writeHead(response.statusCode!, forwardedHeaders(response.headers));
          response.on('error', () => res.destroy());
          response.pipe(res);
        });
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502, { Connection: 'close' }).end();
          else res.destroy();
        });
        res.once('close', () => agent?.destroy());
        req.pipe(upstream);
      } catch {
        agent?.destroy();
        if (!res.destroyed) res.writeHead(502, { Connection: 'close' }).end();
      }
    })();
  });
  server.maxConnections = 128;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, client: Socket, head) => {
    const match = /^(?:\[([a-fA-F0-9:]+)\]|([a-zA-Z0-9.-]+)):(\d{1,5})$/.exec(req.url ?? '');
    const port = Number(match?.[3]);
    if (!match || port < 1 || port > 65535) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const controller = new AbortController();
    client.once('close', () => controller.abort());
    // Read while dialing so a cancelled client releases its pending connection.
    // Bound the uncommon payload sent before the CONNECT response.
    const pending: Buffer[] = [head];
    let pendingBytes = head.length;
    const collect = (chunk: Buffer) => {
      pendingBytes += chunk.length;
      if (pendingBytes > 64 * 1024) client.destroy();
      else pending.push(chunk);
    };
    const ended = () => client.destroy();
    client.on('data', collect).once('end', ended);
    client.resume();
    void (async () => {
      try {
        const upstream = await dial(match[1] ?? match[2]!, port, controller.signal);
        if (client.destroyed) { upstream.destroy(); return; }
        client.pause();
        client.off('data', collect).off('end', ended);
        upstream.on('error', () => client.destroy());
        upstream.once('close', () => {
          // On a normal EOF, pipe() ends the client after its buffered writes drain.
          if (!upstream.readableEnded) client.destroy();
        });
        client.once('close', () => upstream.destroy());
        for (const socket of [client, upstream]) {
          socket.setNoDelay(true);
          socket.setKeepAlive(true, 30_000);
          socket.setTimeout(0); // No idle deadline on a model's streaming response.
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        for (const chunk of pending) if (chunk.length) upstream.write(chunk);
        upstream.pipe(client);
        client.pipe(upstream); // Native backpressure; never buffer or replay a request.
      } catch {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
