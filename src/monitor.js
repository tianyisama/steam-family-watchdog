import { SteamError } from './steam.js';
import fs from 'node:fs';
import path from 'node:path';

export function nextDelay(config, failures, error, random = Math.random) {
  const base = failures ? Math.min(3600, config.poll_seconds * 2 ** Math.min(failures, 10)) : config.poll_seconds;
  const authPause = ['AUTH_REQUIRED', 'ACCESS_DENIED', 'NO_FAMILY'].includes(error?.code) ? 900 : 0;
  return Math.max(base, error?.retryAfterSeconds || 0, authPause) + Math.floor(random() * (config.jitter_seconds + 1));
}

export class Monitor {
  constructor(store, api, config, log = console.log) {
    this.store = store; this.api = api; this.config = config; this.log = log;
    this.family = null; this.familyExpires = 0; this.namesExpires = 0;
    this.failures = 0; this.timer = null; this.running = false; this.stopped = false;
    this.startupPending = true;
    this.status = {
      last_attempt_at: store.meta('last_attempt_at'),
      last_error: JSON.parse(store.meta('last_error') || 'null'),
      next_check_at: store.meta('next_check_at'),
      poll_seconds: config.poll_seconds,
    };
  }
  start() {
    let wait = this.status.last_error
      ? Math.max(0, Date.parse(this.status.next_check_at || '') - Date.now()) : 0;
    // A fresh login can resume an authentication pause. Never bypass a rate-limit pause.
    const authFile = path.join(this.config.dataDir || '.', 'auth.json');
    if (this.status.last_error?.code === 'AUTH_REQUIRED' && fs.existsSync(authFile)
        && fs.statSync(authFile).mtimeMs > Date.parse(this.status.last_error.at)) wait = 0;
    this.timer = setTimeout(() => this.tick(), Number.isFinite(wait) ? wait : 0);
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
  async scanOnce() {
    // Detect an auth-file replacement before using cached family membership.
    await this.api.auth.accessToken();
    if (this.account !== this.api.auth.steamid) {
      this.account = this.api.auth.steamid; this.familyExpires = 0; this.namesExpires = 0;
    }
    if (!this.family || Date.now() >= this.familyExpires) {
      this.family = await this.api.family();
      this.familyExpires = Date.now() + 3600_000;
    }
    const apps = await this.api.library(this.family.id, this.config.language);
    if (Date.now() >= this.namesExpires) {
      this.namesExpires = Date.now() + 6 * 3600_000;
      try {
        const names = await this.api.names(this.family.members);
        this.store.saveNames(names, new Date().toISOString());
      } catch (error) {
        if (error.code === 'RATE_LIMIT') throw error;
        this.log('[Steam] 成员昵称暂未取得，本次仍记录游戏及成员 SteamID。');
      }
    }
    const result = this.store.scan(this.family.id, apps, new Date().toISOString(), this.family.members,
      this.config.member_aliases, { startupUnreleased: this.startupPending });
    // Retry a failed initial scan until it succeeds. Each process checks for
    // missing startup notices; Store deduplicates against persistent history.
    this.startupPending = false;
    return result;
  }
  async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    this.status.last_attempt_at = new Date().toISOString();
    this.store.setMeta('last_attempt_at', this.status.last_attempt_at);
    let failure;
    try {
      const result = await this.scanOnce();
      this.failures = 0; this.status.last_error = null;
      this.log(`[Steam] ${result.baseline_created ? '已建立基线' : '检查完成'}：${result.game_count} 款游戏，本轮新增 ${result.event_count} 条，累计记录 ${this.store.status().event_count} 条事件。`);
    } catch (error) {
      failure = error instanceof SteamError ? error : new SteamError('SCAN_FAILED', '库存验证或本地存储失败，本次不推进基线');
      this.failures++;
      this.status.last_error = { code: failure.code, message: failure.message, at: new Date().toISOString() };
      if (['NO_FAMILY', 'ACCESS_DENIED'].includes(failure.code)) this.familyExpires = 0;
      this.log(`[Steam] ${failure.message}`);
    } finally {
      this.running = false;
      if (!this.stopped) {
        const seconds = nextDelay(this.config, this.failures, failure);
        this.store.setMeta('last_error', JSON.stringify(this.status.last_error));
        this.status.next_check_at = new Date(Date.now() + seconds * 1000).toISOString();
        this.store.setMeta('next_check_at', this.status.next_check_at);
        this.timer = setTimeout(() => this.tick(), seconds * 1000);
      }
    }
  }
}
