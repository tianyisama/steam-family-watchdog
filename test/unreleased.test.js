import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, normalizeApps } from '../src/store.js';
import { Monitor } from '../src/monitor.js';

const A='76561198000000001', B='76561198000000002';
const T=['2026-10-06T13:00:00Z','2026-10-06T13:01:00Z','2026-10-06T13:02:00Z','2026-10-28T08:00:00Z'];
const ACQUIRED=Date.parse('2026-10-06T12:59:00Z')/1000;
const ordinary={appid:10,name:'原有游戏',owner_steamids:[A],exclude_reason:0,app_type:1};
const preorder={appid:4115450,name:'影之刃零',owner_steamids:[B],exclude_reason:8,app_type:1,rt_time_acquired:ACQUIRED};

test('preorder is notified with its owner and retained until ACK; release does not create another acquisition', () => {
  const db=new Store();
  db.scan('1',[ordinary],T[0],[A,B]);
  db.changes('clientA'); db.changes('clientB');
  db.saveNames({[B]:'购买成员'},T[0]);
  assert.equal(db.scan('1',[ordinary,preorder],T[1],[A,B]).event_count,1);
  const pending=db.changes('clientA');
  assert.equal(pending.count,1);
  const event=pending.new_games[0];
  assert.equal(event.name,'影之刃零');
  assert.equal(event.type,'game_added');
  assert.equal(event.is_unreleased,true);
  assert.equal(event.exclude_reason,8);
  assert.deepEqual(event.added_owners,[{steamid:B,name:'购买成员'}]);
  assert.equal(event.rt_time_acquired,ACQUIRED);
  assert.equal(db.scan('1',[ordinary,preorder],T[2],[A,B]).event_count,0);
  assert.equal(db.changes('clientA').delivery_id,pending.delivery_id);
  db.ack('clientA',pending.delivery_id);
  assert.equal(db.changes('clientA').count,0);
  assert.equal(db.changes('clientB').count,1);
  assert.equal(db.scan('1',[ordinary,{...preorder,exclude_reason:0}],T[3],[A,B]).event_count,0);
  assert.equal(db.games().find(game=>game.appid===4115450).is_unreleased,false);
  assert.equal(db.changes('clientB').new_games[0].is_unreleased,true); // Historical event captures detection state.
  assert.equal(db.status().event_count,1);
  db.close();
});

test('preorders in the initial snapshot remain a silent baseline; additional owners are still detected', () => {
  const db=new Store();
  assert.equal(db.scan('1',[ordinary,preorder],T[0],[A,B]).event_count,0);
  db.changes('A');
  assert.equal(db.scan('1',[ordinary,{...preorder,owner_steamids:[A,B]}],T[1],[A,B]).event_count,1);
  const event=db.changes('A').new_games[0];
  assert.equal(event.type,'owner_added');
  assert.equal(event.is_unreleased,true);
  assert.deepEqual(event.added_owners.map(owner=>owner.steamid),[A]);
  db.close();
});

test('only unreleased exclusions are added; private, partner-excluded, free games and non-games remain filtered', () => {
  const rows=[ordinary,preorder,
    ...[1,3,4,6,24,25,28,30].map((reason,i)=>({...ordinary,appid:100+i,exclude_reason:reason})),
    {...preorder,appid:200,app_type:2}];
  assert.deepEqual(normalizeApps(rows).map(app=>app.appid),[10,4115450]);
});

test('startup pushes unreleased inventory once, including on a new installation; ordinary games stay silent', () => {
  const db=new Store();
  const result=db.scan('1',[ordinary,preorder],T[0],[A,B],{}, {startupUnreleased:true});
  assert.equal(result.baseline_created,true);
  assert.equal(result.event_count,1);
  const batch=db.changes('A');
  assert.equal(batch.new_games[0].appid,4115450);
  assert.equal(batch.new_games[0].startup_scan,true);
  assert.equal(batch.new_games[0].source_context,'startup_unreleased');
  assert.equal(batch.new_games[0].observed_after,null);
  db.ack('A',batch.delivery_id);
  assert.equal(db.scan('1',[ordinary,preorder],T[1],[A,B]).event_count,0);
  assert.equal(db.scan('1',[ordinary,preorder],T[2],[A,B],{}, {startupUnreleased:true}).event_count,1);
  assert.equal(db.changes('A').count,1); // A later process restart explicitly requests another push.
  db.close();
});

test('a newly acquired preorder on startup creates one event rather than an acquisition plus a startup duplicate', () => {
  const db=new Store();
  db.scan('1',[ordinary],T[0],[A,B]);
  const result=db.scan('1',[ordinary,preorder],T[1],[A,B],{}, {startupUnreleased:true});
  assert.equal(result.event_count,1);
  assert.equal(db.status().event_count,1);
  assert.equal(db.changes('A').new_games[0].startup_scan,true);
  db.close();
});

test('monitor retries failed startup scanning, pushes only on its first successful scan, and re-enables on restart', async () => {
  const db=new Store();
  db.scan('1',[ordinary,preorder],T[0],[A,B]);
  db.changes('A');
  let fail=true;
  const api={auth:{steamid:A,accessToken:async()=> 'fake-token'},
    family:async()=> ({id:'1',members:[A,B]}),names:async()=> ({}),
    library:async()=> {if(fail)throw new Error('simulated offline');return [ordinary,preorder];}};
  const config={poll_seconds:60,jitter_seconds:0,language:'schinese',member_aliases:{}};
  const first=new Monitor(db,api,config,()=>{});
  await assert.rejects(()=>first.scanOnce());
  assert.equal(first.startupPending,true);
  assert.equal(db.status().event_count,0);
  fail=false;
  assert.equal((await first.scanOnce()).event_count,1);
  assert.equal(first.startupPending,false);
  assert.equal((await first.scanOnce()).event_count,0);
  const restarted=new Monitor(db,api,config,()=>{});
  assert.equal((await restarted.scanOnce()).event_count,1);
  assert.equal((await restarted.scanOnce()).event_count,0);
  assert.equal(db.status().event_count,2);
  db.close();
});
