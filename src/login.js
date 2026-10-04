import path from 'node:path';
import fs from 'node:fs';
import steamSession from 'steam-session';
import QRCode from 'qrcode';
import { loadConfig, atomicJson, acquireLock } from './config.js';

const { LoginSession, EAuthTokenPlatformType } = steamSession;
let session;
let release;
try {
  const config = loadConfig();
  release = acquireLock(config.dataDir);
  session = new LoginSession(EAuthTokenPlatformType.MobileApp);
  session.loginTimeout = 180_000;
  const qrFile = path.join(config.dataDir, 'login-qr.png');
  let finished = false;
  const clean = () => {
    if (finished) return;
    finished = true;
    if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
    release();
  };
  session.on('authenticated', () => {
    try {
      atomicJson(path.join(config.dataDir, 'auth.json'), {
        platform: 'MobileApp', steamid: session.steamID.getSteamID64(),
        refresh_token: session.refreshToken, saved_at: new Date().toISOString(),
      });
      console.log('Steam 登录成功；长期凭据已保存。现在可以运行 npm start。');
    } catch { console.error('登录成功，但保存凭据失败，请检查 data 目录权限。'); process.exitCode = 1; }
    clean();
  });
  session.on('remoteInteraction', () => console.log('已扫描二维码，请在 Steam 手机 App 中确认此次登录。'));
  session.on('timeout', () => { console.log('二维码已过期，请重新运行 npm run login:qr。'); clean(); process.exitCode = 1; });
  session.on('error', () => { console.error('Steam 登录失败，请检查网络并重试。'); clean(); process.exitCode = 1; });
  process.on('SIGINT', () => { session.cancelLoginAttempt(); clean(); });
  process.on('SIGTERM', () => { session.cancelLoginAttempt(); clean(); });
  const result = await session.startWithQR();
  await QRCode.toFile(qrFile, result.qrChallengeUrl, { width: 440, margin: 4 });
  console.log(await QRCode.toString(result.qrChallengeUrl, { type: 'terminal', small: true }));
  console.log(`请使用 Steam 手机 App 扫码并确认登录。二维码图片：${qrFile}`);
} catch {
  if (session) session.cancelLoginAttempt(); if (release) release();
  console.error('无法开始登录，请检查网络和配置；若后端正在运行，请先停止后端。');
  process.exitCode = 1;
}
