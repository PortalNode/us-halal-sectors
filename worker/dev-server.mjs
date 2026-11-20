// خادم محلي للاختبار: node worker/dev-server.mjs  → http://localhost:8790
import { createServer } from 'node:http';
import worker from './live-worker.js';
createServer(async (req, res) => {
  const r = await worker.fetch(new Request(`http://localhost:8790${req.url}`, { method: req.method }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8790, '127.0.0.1', () => console.log('live worker on http://localhost:8790'));
