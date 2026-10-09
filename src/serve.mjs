// Serve any Web-standard fetch handler (a Cloudflare Worker, for example) on a local port.
// Used by the tests and the demo so real product code can be reached over real HTTP.
import { createServer } from 'node:http';

export async function serveFetch(handler, { port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const url = `http://${req.headers.host}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, duplex: 'half' });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
      }
      res.end();
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error?.stack || error));
    }
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const { port: actual } = server.address();
  return { url: `http://${host}:${actual}`, port: actual, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

// Reserve a free port so an app can be built knowing its own base URL before it is served.
export async function freePort() {
  const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address(); await new Promise(r => s.close(r)); return port;
}
