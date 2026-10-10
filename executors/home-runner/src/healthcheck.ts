import http from 'node:http';

// Docker の HEALTHCHECK から呼ぶ。/healthz が 200 なら終了コード 0
const port = Number(process.env.HEALTH_PORT ?? '8080');
const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 4000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
