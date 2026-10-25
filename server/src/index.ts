import { createGameServer } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error('PORT must be an integer between 0 and 65535');
}

const gameServer = createGameServer({ serveStatic: true });

gameServer.httpServer.listen(port, '0.0.0.0', () => {
  // Deliberately only reports the listening port, never credentials or room state.
  console.log(`small-web-game listening on 0.0.0.0:${port}`);
});

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  // The sole intentionally server-wide event: clients need an explicit warning
  // before this in-memory M1 process is terminated.
  gameServer.io.emit('server:restarting', { message: '服务器正在重启，当前内存房间将失效。' });
  setTimeout(() => {
    void gameServer.close().finally(() => process.exit(0));
  }, 25).unref();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
