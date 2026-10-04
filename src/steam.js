import fs from 'node:fs';
import path from 'node:path';
import steamSession from 'steam-session';
import { atomicJson } from './config.js';

const { LoginSession, EAuthTokenPlatformType } = steamSession;

export class SteamError extends Error {
  constructor(code, message, retryAfterSeconds = 0) {
    super(message); this.code = code; this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function tokenClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw new SteamError('AUTH_REQUIRED', '登录凭据格式无效，请重新登录'); }
}

export function retryAfter(header, now = Date.now()) {
  if (!header) return 0;
  const number = Number(header);
  if (Number.isFinite(number) && number >= 0) return Math.ceil(number);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : 0;
}

export function authError(error) {
  if (error instanceof SteamError) return error;
  const result = Number(error.eresult);
  if ([5, 15, 27, 65].includes(result))
    return new SteamError('AUTH_REQUIRED', 'Steam 登录凭据已失效或类型不匹配，请重新登录');
  if ([25, 84].includes(result)) return new SteamError('RATE_LIMIT', 'Steam 限制了请求频率', 900);
  return new SteamError('AUTH_NETWORK', 'Steam 登录服务暂不可用，稍后重试');
}

export class SteamAuth {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'auth.json');
    this.session = null;
    this.signature = null;
    this.state = 'not_logged_in';
    this.steamid = null;
  }
  load() {
    if (!fs.existsSync(this.file)) throw new SteamError('AUTH_REQUIRED', '尚未登录，请运行 npm run login');
    const signature = fs.readFileSync(this.file, 'utf8');
    if (signature === this.signature) return;
    let data;
    try { data = JSON.parse(signature); } catch { throw new SteamError('AUTH_REQUIRED', '登录文件损坏，请重新登录'); }
    const claims = tokenClaims(data.refresh_token || '');
    if (data.platform !== 'MobileApp' || !claims.aud?.includes('mobile'))
      throw new SteamError('AUTH_REQUIRED', '请使用本程序登录获得 MobileApp 类型的凭据');
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now())
      throw new SteamError('AUTH_REQUIRED', '长期登录凭据已过期，请重新登录');
    try {
      this.session = new LoginSession(EAuthTokenPlatformType.MobileApp);
      this.session.refreshToken = data.refresh_token;
      this.steamid = this.session.steamID.getSteamID64();
      this.signature = signature;
      this.state = 'loaded';
    } catch (error) { throw authError(error); }
  }
  async accessToken(force = false) {
    try {
      this.load();
      const access = this.session.accessToken;
      if (!force && access && tokenClaims(access).exp * 1000 > Date.now() + 300_000) return access;
      const refresh = tokenClaims(this.session.refreshToken);
      // Only ask to renew the long-lived credential near expiry. Valve can decline renewal.
      if (refresh.exp * 1000 < Date.now() + 7 * 86400_000) {
        const renewed = await this.session.renewRefreshToken();
        if (renewed) {
          atomicJson(this.file, {
            platform: 'MobileApp', steamid: this.steamid,
            refresh_token: this.session.refreshToken, saved_at: new Date().toISOString(),
          });
          this.signature = fs.readFileSync(this.file, 'utf8');
        }
      } else await this.session.refreshAccessToken();
      this.state = 'authenticated';
      return this.session.accessToken;
    } catch (error) {
      const safe = authError(error);
      this.state = safe.code === 'AUTH_REQUIRED' ? 'needs_login' : 'temporarily_unavailable';
      throw safe;
    }
  }
}

export class SteamApi {
  constructor(auth, fetchImpl = fetch) { this.auth = auth; this.fetch = fetchImpl; }
  async call(service, method, params = {}, retryAuth = true) {
    const token = await this.auth.accessToken();
    const url = new URL(`https://api.steampowered.com/${service}/${method}/v1/`);
    url.searchParams.set('access_token', token);
    // Steam Unified Web API methods accept structured requests via input_json.
    url.searchParams.set('input_json', JSON.stringify(params));
    let response;
    try {
      response = await this.fetch(url, {
        signal: AbortSignal.timeout(30_000), redirect: 'error',
        headers: { 'Accept': 'application/json', 'User-Agent': 'SteamFamilyMonitor/1.0' },
      });
    } catch { throw new SteamError('NETWORK_ERROR', 'Steam 请求超时或网络连接失败'); }
    const result = Number(response.headers.get('x-eresult') || 1);
    if (response.status === 429 || [25, 84].includes(result))
      throw new SteamError('RATE_LIMIT', 'Steam 限制了请求频率', Math.max(900, retryAfter(response.headers.get('retry-after'))));
    if (response.status === 401 || result === 27) {
      if (retryAuth) {
        await this.auth.accessToken(true);
        return this.call(service, method, params, false);
      }
      throw new SteamError('AUTH_REQUIRED', 'Steam 拒绝了登录凭据，请重新登录');
    }
    if (response.status === 403 || result === 15)
      throw new SteamError('ACCESS_DENIED', 'Steam 拒绝访问，请检查登录账号的家庭成员资格');
    if (!response.ok || result !== 1)
      throw new SteamError('STEAM_UNAVAILABLE', `Steam 接口暂不可用（HTTP ${response.status}，EResult ${result}）`, retryAfter(response.headers.get('retry-after')));
    let body;
    try { body = await response.json(); } catch { throw new SteamError('INVALID_RESPONSE', 'Steam 返回了无法解析的结果，本次不更新库存'); }
    if (!body || typeof body.response !== 'object' || body.response === null || Array.isArray(body.response))
      throw new SteamError('INVALID_RESPONSE', 'Steam 返回的结果缺少 response，本次不更新库存');
    return body.response;
  }
  async family() {
    const result = await this.call('IFamilyGroupsService', 'GetFamilyGroupForUser', {
      steamid: this.auth.steamid || (await this.auth.accessToken(), this.auth.steamid),
      include_family_group_response: true,
    });
    if (result.is_not_member_of_any_group || !result.family_groupid || result.family_groupid === '0')
      throw new SteamError('NO_FAMILY', '登录账号目前没有可用的 Steam 家庭');
    if (typeof result.family_groupid !== 'string' || !/^\d+$/.test(result.family_groupid))
      throw new SteamError('INVALID_RESPONSE', 'Steam 家庭 ID 格式无效');
    const members = (result.family_group?.members || []).map(member => member.steamid);
    if (members.some(id => typeof id !== 'string' || !/^\d{17}$/.test(id)))
      throw new SteamError('INVALID_RESPONSE', 'Steam 家庭成员 ID 格式无效');
    return { id: result.family_groupid, members };
  }
  async library(familyId, language) {
    const result = await this.call('IFamilyGroupsService', 'GetSharedLibraryApps', {
      family_groupid: familyId, include_own: true, include_excluded: false,
      include_non_games: false, language,
    });
    if (!Array.isArray(result.apps))
      throw new SteamError('INVALID_RESPONSE', 'Steam 未返回完整 apps 数组，本次不更新库存');
    return result.apps;
  }
  async names(ids) {
    if (!ids.length) return {};
    const result = await this.call('IPlayerService', 'GetPlayerLinkDetails', { steamids: ids });
    const names = {};
    for (const account of result.accounts || []) {
      const data = account.public_data;
      if (data && ids.includes(data.steamid) && typeof data.persona_name === 'string')
        names[data.steamid] = data.persona_name;
    }
    return names;
  }
}
