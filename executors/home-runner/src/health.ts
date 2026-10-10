import http from 'node:http';

/** isHealthy() が true なら 200、そうでなければ 503 を返す */
export function createHealthServer(isHealthy: () => boolean): http.Server {
  return http.createServer((req, res) => {
    req.resume();
    if (req.method !== 'GET' || req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const ok = isHealthy();
    const body = JSON.stringify({ status: ok ? 'ok' : 'unavailable' });
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
}
