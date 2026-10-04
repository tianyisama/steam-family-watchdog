import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const configPath = path.join(ROOT, 'config.json');
  const config = { ...defaults, ...(fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}) };
  for (const [key, min, max] of [
    ['port', 1, 65535], ['poll_seconds', 60, 86400],
    ['jitter_seconds', 0, 300], ['missing_confirmations', 1, 10],
  ]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max)
      throw new Error(`config.json 中 ${key} 必须为 ${min}～${max} 的整数`);
  }
  if (typeof config.host !== 'string' || typeof config.data_dir !== 'string'
      || typeof config.language !== 'string' || !config.member_aliases
      || typeof config.member_aliases !== 'object' || Array.isArray(config.member_aliases))
    throw new Error('config.json 的地址、路径、语言或成员别名无效');
  config.dataDir = path.resolve(ROOT, config.data_dir);
  config.apiSecret = process.env.MONITOR_API_SECRET || '';
  if (config.apiSecret.length < 32 || config.apiSecret.startsWith('replace-'))
    throw new Error('请先运行 npm run setup，或配置至少 32 字符的 MONITOR_API_SECRET');
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return config;
}

export function atomicJson(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

// Fail closed if another process is using this data directory. A stale lock is
// recovered only when its PID is definitely absent on this machine.
export function acquireLock(dataDir) {
  const lockPath = path.join(dataDir, 'monitor.lock');
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('实例锁无效，请检查 data/monitor.lock');
    try { process.kill(pid, 0); }
    catch (check) {
      if (check.code === 'ESRCH') {
        fs.unlinkSync(lockPath);
        return acquireLock(dataDir);
      }
      throw new Error('无法确认实例锁，拒绝重复启动');
    }
    throw new Error('此数据目录已有进程运行，请先停止它');
  }
  return () => {
    if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8') === String(process.pid))
      fs.unlinkSync(lockPath);
  };
}
