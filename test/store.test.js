import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

const A = '76561198000000001', B = '76561198000000002';
const game = (appid, owners = [A], acquired = 1700000000) => ({ appid, name: `Game ${appid}`, owner_steamids: owners, rt_time_acquired: acquired });
const T = ['2026-10-04T16:00:00.000Z', '2026-10-04T16:05:00.000Z', '2026-10-04T16:10:00.000Z', '2026-10-04T16:15:00.000Z'];

test('first snapshot is silent; new games and new owners have distinct source members and times', () => {
  const db = new Store();
  assert.equal(db.scan('1', [game(10)], T[0], [A,B]).event_count, 0);
  db.saveNames({ [A]: '成员A', [B]: '成员B' }, T[0]);
  db.register('groupA');
  assert.equal(db.scan('1', [game(10,[A,B]), game(20,[B])], T[1], [A,B]).event_count, 2);
  const batch = db.changes('groupA');
  assert.deepEqual(batch.new_games.map(e => e.type), ['owner_added','game_added']);
  assert.deepEqual(batch.new_games[0].added_owners, [{steamid:B,name:'成员B'}]);
  assert.equal(batch.new_games[0].observed_after, T[0]);
  assert.equal(batch.new_games[0].detected_at, T[1]);
  assert.equal(batch.new_games[0].acquired_time_verified, false);
  db.close();
});

test('clients are independent; GET never consumes events; ACK is idempotent and cannot skip unseen events', () => {
  const db = new Store(); db.scan('1',[game(10)],T[0]);
  db.register('A'); db.register('B');
  db.scan('1',[game(10),game(20)],T[1]);
  const a = db.changes('A'), b = db.changes('B');
  assert.deepEqual(db.changes('A'), a);
  assert.notEqual(a.delivery_id,b.delivery_id);
  assert.throws(() => db.ack('A',b.delivery_id), {code:'delivery_mismatch'});
  db.scan('1',[game(10),game(20),game(30)],T[2]);
  const repeated = db.changes('A'); // Backlog metadata can change; the delivery cannot.
  assert.equal(repeated.delivery_id, a.delivery_id);
  assert.deepEqual(repeated.new_games, a.new_games);
  assert.equal(repeated.has_more, true);
  db.ack('A',a.delivery_id);
  assert.equal(db.ack('A',a.delivery_id).already_acked,true);
  assert.deepEqual(db.changes('A').new_games.map(e=>e.appid),[30]);
  assert.deepEqual(db.changes('B').new_games.map(e=>e.appid),[20]);
  db.close();
});

test('client start policy, pagination, pending delivery and baseline survive database reopen', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'steam-monitor-test-'));
  const file = path.join(temp,'monitor.db');
  let db = new Store(file);
  db.scan('1',[game(10)],T[0]); db.scan('1',[game(10),game(20),game(30)],T[1]);
  assert.equal(db.changes('late').count,2); // First polling request must not discard detected changes.
  db.register('explicit_latest','latest');
  assert.equal(db.changes('explicit_latest').count,0);
  db.register('replay','beginning');
  const pending = db.changes('replay',1);
  assert.equal(pending.has_more,true);
  db.close(); db = new Store(file);
  assert.deepEqual(db.changes('replay',100),pending);
  db.ack('replay',pending.delivery_id);
  assert.deepEqual(db.changes('replay').new_games.map(e=>e.appid),[30]);
  assert.equal(db.scan('1',[game(10),game(20),game(30)],T[2]).event_count,0);
  db.close();
  fs.rmSync(temp,{recursive:true,force:true});
});

test('invalid Steam results never overwrite snapshots or advance observation time', () => {
  const db = new Store(); db.scan('1',[game(10)],T[0]); db.register('A');
  for (const malformed of [undefined,{},[game(10),game(10)],[{...game(10),owner_steamids:[76561198000000001]}]])
    assert.throws(()=>db.scan('1',malformed,T[1]));
  assert.deepEqual(db.games().map(g=>g.appid),[10]);
  assert.equal(db.status().last_success_at,T[0]);
  assert.equal(db.changes('A').count,0);
  db.close();
});

test('transient disappearance does not produce duplicate re-adds; confirmed disappearance can re-add', () => {
  const db = new Store(); db.scan('1',[game(10)],T[0]); db.register('A');
  db.scan('1',[],T[1]);
  assert.equal(db.scan('1',[game(10)],T[2]).event_count,0);
  db.scan('1',[],T[2]); db.scan('1',[],T[3]);
  assert.equal(db.scan('1',[game(10)],T[3]).event_count,1);
  db.close();
});

test('owner changes use confirmed missing owners; unknown owners do not erase known owners', () => {
  const db = new Store(); db.scan('1',[game(10,[A,B])],T[0]);
  db.scan('1',[game(10,[A])],T[1]);
  assert.equal(db.scan('1',[game(10,[A,B])],T[2]).event_count,0);
  db.scan('1',[game(10,[])],T[2]);
  assert.equal(db.scan('1',[game(10,[A,B])],T[3]).event_count,0);
  db.scan('1',[game(10,[A])],T[2]); db.scan('1',[game(10,[A])],T[3]);
  assert.equal(db.scan('1',[game(10,[A,B])],T[3]).event_count,1);
  db.close();
});

test('new family has a separate silent baseline; member arrival is not called a purchase', () => {
  const db = new Store(); db.scan('1',[game(10)],T[0],[A]); db.register('A');
  db.scan('1',[game(10),game(20,[B])],T[1],[A,B]);
  assert.equal(db.changes('A').new_games[0].source_context,'member_joined');
  assert.equal(db.scan('2',[game(100)],T[2],[A]).event_count,0);
  db.close();
});

test('no client registration before Steam baseline; rejected identifiers and limits', () => {
  const db = new Store();
  assert.throws(()=>db.register('A'),{code:'not_ready'});
  assert.throws(()=>db.changes('../x'),{code:'invalid_clientid'});
  db.scan('1',[game(10)],T[0]);
  assert.throws(()=>db.changes('A',0),{code:'invalid_limit'});
  db.close();
});

test('198 -> 199 -> 199 preserves the event and original time for both early and late clients', () => {
  const db = new Store();
  const baseline = Array.from({length:198},(_,i)=>game(i+1));
  assert.equal(db.scan('1',baseline,T[0],[A,B]).baseline_created,true);
  db.changes('early');
  const expanded = [...baseline,game(999,[B],1700001000)];
  assert.equal(db.scan('1',expanded,T[1],[A,B]).event_count,1);
  const before = db.changes('early');
  assert.equal(before.count,1);
  assert.equal(db.scan('1',expanded,T[2],[A,B]).event_count,0);
  const after = db.changes('early');
  assert.deepEqual(after.new_games,before.new_games);
  assert.equal(after.delivery_id,before.delivery_id);
  assert.equal(after.new_games[0].detected_at,T[1]);
  assert.equal(after.new_games[0].appid,999);
  assert.deepEqual(after.new_games[0].added_owners.map(o=>o.steamid),[B]);
  const late = db.changes('late');
  assert.equal(late.count,1);
  assert.equal(late.new_games[0].event_id,after.new_games[0].event_id);
  db.ack('early',after.delivery_id);
  assert.equal(db.changes('early').count,0);
  assert.equal(db.changes('late').count,1);
  assert.equal(db.status().event_count,1); // ACK does not delete history either.
  db.close();
});
