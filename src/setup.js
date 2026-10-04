import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT } from './config.js';

const configPath = path.join(ROOT, 'config.json');
if (!fs.existsSync(configPath))
  fs.copyFileSync(path.join(ROOT, 'config.example.json'), configPath);
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath))
  fs.writeFileSync(envPath, `MONITOR_API_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
console.log('配置已准备好。接口密钥保存在 .env；首次使用请运行 npm run login。');
