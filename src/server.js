import path from 'node:path';
import { loadConfig, acquireLock } from './config.js';
import { Store } from './store.js';
import { SteamAuth, SteamApi } from './steam.js';
import { Monitor } from './monitor.js';
import { createServer } from './http.js';

let release;
let store;
try {
  const config = loadConfig();
  release = acquireLock(config.dataDir);
  store = new Store(path.join(config.dataDir, 'monitor.sqlite3'), config.missing_confirmations);
  const auth = new SteamAuth(config.dataDir);
  const monitor = new Monitor(store, new SteamApi(auth), config);
  const server = createServer(store, monitor, auth, config.apiSecret);
  server.on('error', error => {
    console.error(`接口启动失败：${error.code || 'UNKNOWN'}。`);
    monitor.stop(); store.close(); release(); process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`Steam 家庭库接口已启动：${config.host}:${config.port}，检查间隔 ${config.poll_seconds} 秒。`);
    monitor.start();
  });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true; monitor.stop();
    server.close(async () => {
      // An in-flight request may still be writing its successful scan.
      while (monitor.running) await new Promise(resolve => setTimeout(resolve, 100));
      store.close(); release();
    });
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch {
  console.error('启动失败：请检查配置、数据库权限及实例锁；首次使用先执行 npm run setup。');
  if (store) store.close(); if (release) release(); process.exitCode = 1;
}
