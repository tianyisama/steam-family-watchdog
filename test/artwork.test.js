import test from 'node:test';
import assert from 'node:assert/strict';
import { artwork } from '../src/artwork.js';
import { Store } from '../src/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const owner = '76561198000000001';
const hash = 'f568912870a4684f9ec76277a1a404dda6bab213';
const game = (appid, images = true) => ({appid,name:`中文游戏${appid}`,owner_steamids:[owner],
  ...(images ? {capsule_filename:'abc123/library_capsule.jpg',img_icon_hash:hash} : {})});

test('raw Steam assets become fixed-host image URLs; unsafe paths and missing images remain null', () => {
  const images = artwork(440,'library_600x900.jpg',hash);
  assert.equal(images.capsule_image_url,'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/440/library_600x900.jpg');
  assert.equal(images.icon_image_url,`https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/440/${hash}.jpg`);
  assert.equal(images.image_url,images.capsule_image_url);
  for (const file of ['../secret.png','https://evil.invalid/image.png','a/../../b.jpg','a\\b.jpg'])
    assert.equal(artwork(440,file,hash).capsule_image_url,null);
  assert.equal(artwork(440,null,hash).image_url,images.icon_image_url);
  assert.equal(artwork(440,null,'invalid').image_url,null);
});

test('Chinese names and artwork survive snapshots and notification delivery without creating repeat events', () => {
  const db = new Store();
  db.scan('1',[game(10)],'2026-10-04T16:00:00Z');
  db.changes('A');
  db.scan('1',[game(10),game(20)],'2026-10-04T16:05:00Z');
  const batch=db.changes('A');
  assert.equal(batch.new_games[0].name,'中文游戏20');
  assert.ok(batch.new_games[0].capsule_image_url.endsWith('/20/abc123/library_capsule.jpg'));
  assert.equal(db.games()[0].img_icon_hash,hash);
  assert.equal(db.scan('1',[game(10),game(20)],'2026-10-04T16:10:00Z').event_count,0);
  assert.deepEqual(db.changes('A').new_games,batch.new_games);
  db.ack('A',batch.delivery_id);
  assert.equal(db.changes('A').count,0);
  assert.equal(db.status().event_count,1);
  db.close();
});

test('legacy pending events can gain images without changing stored payload, batch ID or cursor', () => {
  const db=new Store();
  db.scan('1',[game(10)],'2026-10-04T16:00:00Z');
  db.changes('A');
  db.scan('1',[game(10),game(20)],'2026-10-04T16:05:00Z');
  const batch=db.changes('A');
  const original={...batch.new_games[0]};
  for (const key of ['event_id','capsule_filename','img_icon_hash','capsule_image_url','icon_image_url','image_url']) delete original[key];
  const legacy=JSON.stringify(original);
  db.db.prepare('UPDATE events SET payload=? WHERE id=?').run(legacy,batch.new_games[0].event_id);
  const upgraded=db.changes('A');
  assert.equal(upgraded.delivery_id,batch.delivery_id);
  assert.equal(upgraded.cursor,batch.cursor);
  assert.equal(upgraded.new_games[0].detected_at,original.detected_at);
  assert.ok(upgraded.new_games[0].image_url);
  assert.equal(db.db.prepare('SELECT payload FROM events WHERE id=?').get(batch.new_games[0].event_id).payload,legacy);
  db.close();
});

test('legacy games table stays unchanged and a missing artwork table is added without resetting clients', () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'steam-artwork-migration-'));
  const file=path.join(temp,'monitor.db');
  let db=new Store(file);
  db.scan('1',[game(10,false)],'2026-10-04T16:00:00Z');
  db.changes('A');
  db.scan('1',[game(10,false),game(20,false)],'2026-10-04T16:05:00Z');
  const pending=db.changes('A');
  db.db.exec('DROP TABLE game_artwork');
  db.close();
  db=new Store(file);
  assert.deepEqual(db.db.prepare('PRAGMA table_info(games)').all().map(c=>c.name),
    ['family_id','appid','name','owners','acquired','missing']);
  assert.equal(db.db.prepare('SELECT cursor FROM clients WHERE id=?').get('A').cursor,0);
  assert.equal(db.status().event_count,1);
  assert.equal(db.games().length,2);
  assert.equal(db.changes('A').delivery_id,pending.delivery_id);
  assert.equal(db.changes('A').new_games[0].event_id,pending.new_games[0].event_id);
  db.close();
  assert.equal(path.dirname(file),temp);
  fs.rmSync(temp,{recursive:true,force:true});
});
