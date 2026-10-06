import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { artwork } from './artwork.js';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function validClient(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new ApiError(400, 'invalid_clientid', 'clientid 必须为 1～128 字符，只能包含字母、数字、下划线、点、冒号或连字符');
  return value;
}

const json = value => JSON.stringify(value);
const ownersOf = value => JSON.parse(value || '{}');
const idsOf = value => Object.keys(ownersOf(value)).sort();

export function normalizeApps(apps) {
  if (!Array.isArray(apps)) throw new Error('Steam 返回的 apps 不是数组；本次不覆盖库存');
  const seen = new Set();
  const normalized = [];
  for (const item of apps) {
    if (!item || !Number.isInteger(item.appid) || item.appid <= 0 || seen.has(item.appid))
      throw new Error('Steam 返回无效或重复的 AppID；本次不覆盖库存');
    seen.add(item.appid);
    const excludeReason = item.exclude_reason ?? 0;
    if (![0, 8].includes(excludeReason) || (item.app_type ?? 1) !== 1) continue;
    if (item.owner_steamids !== undefined && !Array.isArray(item.owner_steamids))
      throw new Error('Steam 返回无效的 owner_steamids；本次不覆盖库存');
    const owners = [...new Set((item.owner_steamids || []).map(id => {
      if (typeof id !== 'string' || !/^\d{17}$/.test(id))
        throw new Error('SteamID64 必须是字符串，避免整数精度丢失');
      return id;
    }))].sort();
    normalized.push({
      appid: item.appid,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `App ${item.appid}`,
      owners,
      exclude_reason: excludeReason,
      is_unreleased: excludeReason === 8,
      rt_time_acquired: Number.isInteger(item.rt_time_acquired) && item.rt_time_acquired > 0
        ? item.rt_time_acquired : null,
      ...artwork(item.appid, item.capsule_filename, item.img_icon_hash),
    });
  }
  return normalized;
}

export class Store {
  constructor(file = ':memory:', missingConfirmations = 2) {
    this.db = new DatabaseSync(file);
    this.missingConfirmations = missingConfirmations;
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS families (
        id TEXT PRIMARY KEY, initialized INTEGER NOT NULL DEFAULT 0, last_scan TEXT
      );
      CREATE TABLE IF NOT EXISTS games (
        family_id TEXT NOT NULL, appid INTEGER NOT NULL, name TEXT NOT NULL,
        owners TEXT NOT NULL, acquired INTEGER, missing INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(family_id, appid)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY, cursor INTEGER NOT NULL, delivery_id TEXT,
        pending_ids TEXT, last_delivery_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS member_names (
        steamid TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_artwork (
        family_id TEXT NOT NULL, appid INTEGER NOT NULL, details TEXT NOT NULL,
        PRIMARY KEY(family_id, appid)
      );
      CREATE TABLE IF NOT EXISTS game_availability (
        family_id TEXT NOT NULL, appid INTEGER NOT NULL, exclude_reason INTEGER NOT NULL,
        PRIMARY KEY(family_id, appid)
      );
    `);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  meta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null; }
  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(value));
  }
  name(id, aliases = {}) {
    return typeof aliases[id] === 'string' && aliases[id] ? aliases[id]
      : this.db.prepare('SELECT name FROM member_names WHERE steamid=?').get(id)?.name || null;
  }
  saveNames(names, at) {
    const stmt = this.db.prepare('INSERT INTO member_names VALUES (?,?,?) ON CONFLICT(steamid) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at');
    this.transaction(() => { for (const [id, name] of Object.entries(names)) stmt.run(id, name, at); });
  }
  artwork(familyId, appid) {
    const row = this.db.prepare('SELECT details FROM game_artwork WHERE family_id=? AND appid=?').get(familyId, appid);
    return row ? JSON.parse(row.details) : artwork(appid);
  }
  availability(familyId, appid) {
    const row = this.db.prepare('SELECT exclude_reason FROM game_availability WHERE family_id=? AND appid=?').get(familyId, appid);
    const reason = row?.exclude_reason ?? 0;
    return { exclude_reason: reason, is_unreleased: reason === 8 };
  }
  event(row) {
    const payload = JSON.parse(row.payload);
    // Legacy events gain optional images from the snapshot. Do not rewrite
    // stored event IDs, names, owners, times or client acknowledgement positions.
    return { event_id: row.id, ...this.artwork(payload.family_groupid, payload.appid),
      ...this.availability(payload.family_groupid, payload.appid), ...payload };
  }
  scan(familyId, rawApps, detectedAt, members = [], aliases = {}, options = {}) {
    const apps = normalizeApps(rawApps); // Validate the complete response before any write.
    return this.transaction(() => {
      const family = this.db.prepare('SELECT * FROM families WHERE id=?').get(familyId);
      const initial = !family?.initialized;
      const previousMembers = JSON.parse(this.meta(`members:${familyId}`) || '[]');
      const joined = new Set(members.filter(id => !previousMembers.includes(id)));
      const old = new Map(this.db.prepare('SELECT * FROM games WHERE family_id=?').all(familyId)
        .map(row => [row.appid, row]));
      const currentIds = new Set(apps.map(app => app.appid));
      const insert = this.db.prepare(`INSERT INTO games VALUES (?,?,?,?,?,0)
        ON CONFLICT(family_id,appid) DO UPDATE SET name=excluded.name,
          owners=excluded.owners, acquired=excluded.acquired, missing=0`);
      let count = 0;
      for (const app of apps) {
        const prior = old.get(app.appid);
        const priorOwners = ownersOf(prior?.owners);
        const addedOwners = app.owners.filter(id => !(id in priorOwners));
        const owners = {};
        for (const id of app.owners) owners[id] = 0;
        // An omitted owner list is treated as unknown, not as proof of loss.
        if (app.owners.length === 0 && prior) Object.assign(owners, priorOwners);
        else for (const [id, misses] of Object.entries(priorOwners)) {
          if (!(id in owners) && misses + 1 < this.missingConfirmations) owners[id] = misses + 1;
        }
        const acquired = !initial && (!prior || addedOwners.length > 0);
        const startupUnreleased = options.startupUnreleased === true && app.is_unreleased;
        if (acquired || startupUnreleased) {
          const sourceIds = acquired && prior ? addedOwners : app.owners;
          const payload = {
            type: acquired && prior ? 'owner_added' : 'game_added',
            family_groupid: familyId, appid: app.appid, name: app.name,
            owners: app.owners.map(steamid => ({ steamid, name: this.name(steamid, aliases) })),
            added_owners: sourceIds.map(steamid => ({ steamid, name: this.name(steamid, aliases) })),
            source_context: !acquired && startupUnreleased ? 'startup_unreleased'
              : sourceIds.some(id => joined.has(id)) ? 'member_joined' : 'library_change',
            startup_scan: startupUnreleased,
            detected_at: detectedAt,
            observed_after: family?.last_scan ?? null,
            observed_until: detectedAt,
            rt_time_acquired: app.rt_time_acquired,
            steam_acquired_at: app.rt_time_acquired ? new Date(app.rt_time_acquired * 1000).toISOString() : null,
            acquired_time_verified: false,
            exclude_reason: app.exclude_reason,
            is_unreleased: app.is_unreleased,
            ...artwork(app.appid, app.capsule_filename, app.img_icon_hash),
          };
          this.db.prepare('INSERT INTO events(payload) VALUES (?)').run(json(payload));
          count++;
        }
        insert.run(familyId, app.appid, app.name, json(owners), app.rt_time_acquired);
        this.db.prepare(`INSERT INTO game_availability VALUES (?,?,?) ON CONFLICT(family_id,appid)
          DO UPDATE SET exclude_reason=excluded.exclude_reason`).run(familyId, app.appid, app.exclude_reason);
        this.db.prepare(`INSERT INTO game_artwork VALUES (?,?,?) ON CONFLICT(family_id,appid)
          DO UPDATE SET details=excluded.details`).run(familyId, app.appid,
            json(artwork(app.appid, app.capsule_filename, app.img_icon_hash)));
      }
      for (const prior of old.values()) if (!currentIds.has(prior.appid)) {
        if (prior.missing + 1 >= this.missingConfirmations)
          this.db.prepare('DELETE FROM games WHERE family_id=? AND appid=?').run(familyId, prior.appid);
        else this.db.prepare('UPDATE games SET missing=missing+1 WHERE family_id=? AND appid=?').run(familyId, prior.appid);
      }
      this.db.prepare(`INSERT INTO families VALUES (?,1,?) ON CONFLICT(id)
        DO UPDATE SET initialized=1,last_scan=excluded.last_scan`).run(familyId, detectedAt);
      this.setMeta('active_family', familyId);
      this.setMeta(`members:${familyId}`, json(members));
      this.setMeta('last_success_at', detectedAt);
      return { baseline_created: initial, event_count: count, game_count: apps.length };
    });
  }
  ready() { return this.meta('active_family') !== null; }
  latestId() { return this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get().id; }
  register(clientid, start = 'latest') {
    validClient(clientid);
    if (!['latest', 'beginning'].includes(start)) throw new ApiError(400, 'invalid_start', 'start 必须为 latest 或 beginning');
    if (!this.ready()) throw new ApiError(503, 'not_ready', '尚未建立家庭库基线，请先完成 Steam 登录');
    const row = this.db.prepare('SELECT * FROM clients WHERE id=?').get(clientid);
    if (row) return { created: false, cursor: row.cursor };
    const cursor = start === 'beginning' ? 0 : this.latestId();
    this.db.prepare('INSERT INTO clients(id,cursor,created_at) VALUES (?,?,?)').run(clientid, cursor, new Date().toISOString());
    return { created: true, cursor };
  }
  changes(clientid, limit = 10) {
    validClient(clientid);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(400, 'invalid_limit', 'limit 必须为 1～100 的整数');
    return this.transaction(() => {
      // Initial inventory is a silent baseline. A new polling client should
      // receive recorded changes, including those detected before its first GET.
      // Explicit POST /clients with start=latest still supports opting out.
      const registered = this.register(clientid, 'beginning');
      const client = this.db.prepare('SELECT * FROM clients WHERE id=?').get(clientid);
      let rows;
      let deliveryId = client.delivery_id;
      if (deliveryId) {
        const ids = JSON.parse(client.pending_ids);
        rows = ids.map(id => this.db.prepare('SELECT * FROM events WHERE id=?').get(id));
      } else {
        rows = this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(client.cursor, limit);
        if (rows.length) {
          deliveryId = randomUUID();
          this.db.prepare('UPDATE clients SET delivery_id=?,pending_ids=? WHERE id=?')
            .run(deliveryId, json(rows.map(row => row.id)), clientid);
        }
      }
      return {
        success: true, clientid, client_created: registered.created,
        delivery_id: deliveryId || null, count: rows.length,
        new_games: rows.map(row => this.event(row)),
        has_more: this.latestId() > (rows.at(-1)?.id ?? client.cursor),
        cursor: client.cursor,
      };
    });
  }
  ack(clientid, deliveryId) {
    validClient(clientid);
    if (typeof deliveryId !== 'string' || deliveryId.length > 64)
      throw new ApiError(400, 'invalid_delivery_id', '需要有效的 delivery_id');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM clients WHERE id=?').get(clientid);
      if (!row) throw new ApiError(404, 'unknown_client', 'clientid 尚未注册');
      if (row.last_delivery_id === deliveryId) return { success: true, already_acked: true, cursor: row.cursor };
      if (row.delivery_id !== deliveryId) throw new ApiError(409, 'delivery_mismatch', 'delivery_id 与待确认批次不匹配');
      const cursor = Math.max(row.cursor, ...JSON.parse(row.pending_ids));
      this.db.prepare(`UPDATE clients SET cursor=?,last_delivery_id=?,delivery_id=NULL,pending_ids=NULL WHERE id=?`)
        .run(cursor, deliveryId, clientid);
      return { success: true, already_acked: false, cursor };
    });
  }
  games() {
    const familyId = this.meta('active_family');
    return this.db.prepare('SELECT * FROM games WHERE family_id=? AND missing=0 ORDER BY name').all(familyId)
      .map(row => ({ appid: row.appid, name: row.name, owner_steamids: idsOf(row.owners), rt_time_acquired: row.acquired,
        ...this.artwork(familyId, row.appid), ...this.availability(familyId, row.appid) }));
  }
  status() {
    return {
      baseline_ready: this.ready(), family_groupid: this.meta('active_family'),
      last_success_at: this.meta('last_success_at'),
      event_count: this.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
      client_count: this.db.prepare('SELECT COUNT(*) AS n FROM clients').get().n,
    };
  }
}
