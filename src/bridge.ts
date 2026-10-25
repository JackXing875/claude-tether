import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';

export async function localSocket(address: string | number, signal: AbortSignal): Promise<Socket> {
  const socket = typeof address === 'string'
    ? createConnection({ path: address, signal, allowHalfOpen: true })
    : createConnection({ host: '127.0.0.1', port: address, signal, allowHalfOpen: true });
  socket.on('error', () => {});
  try { await once(socket, 'connect'); return socket; }
  catch (error) { socket.destroy(); throw error; }
}

// A private Unix socket crosses the network namespace. Neither side parses,
// records, retries, or buffers whole HTTP requests (including SSE responses).
export async function startBridge(dial: (signal: AbortSignal) => Promise<Socket>, path?: string) {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, client => {
    const controller = new AbortController();
    sockets.add(client);
    client.on('error', () => client.destroy());
    client.once('close', () => { sockets.delete(client); controller.abort(); });
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    const collect = (chunk: Buffer) => {
      pendingBytes += chunk.length;
      pending.push(chunk);
      // Stop reading instead of rejecting a large HTTP upload while SSH dials.
      // At most the threshold plus one socket chunk is held by this bridge.
      if (pendingBytes >= 64 * 1024) client.pause();
    };
    client.on('data', collect);
    void (async () => {
      try {
        const upstream = await dial(controller.signal);
        if (client.destroyed) { upstream.destroy(); return; }
        client.pause();
        client.off('data', collect);
        sockets.add(upstream);
        upstream.on('error', () => client.destroy());
        upstream.once('close', () => {
          sockets.delete(upstream);
          if (!upstream.readableEnded) client.destroy();
        });
        client.once('close', () => upstream.destroy());
        for (const socket of [client, upstream]) {
          socket.allowHalfOpen = true;
          socket.setNoDelay(true);
          socket.setKeepAlive(true, 30_000);
        }
        for (const chunk of pending) upstream.write(chunk);
        upstream.pipe(client);
        // A FIN received while dialing only ends the client's write direction.
        // Flush its buffered bytes and FIN, then keep relaying the response.
        if (client.readableEnded) upstream.end();
        else client.pipe(upstream);
      } catch { client.destroy(); }
    })();
  });
  server.maxConnections = 128;
  if (path) server.listen(path);
  else server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: path ? undefined : (server.address() as { port: number }).port,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
