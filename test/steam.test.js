import test from 'node:test';
import assert from 'node:assert/strict';
import { SteamApi, retryAfter } from '../src/steam.js';
import { nextDelay, Monitor } from '../src/monitor.js';
import { Store } from '../src/store.js';

const config = {poll_seconds:300,jitter_seconds:10,language:'schinese',member_aliases:{}};
const response = (body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});

test('rate limits honor Retry-After; bad responses are not treated as an empty library', async () => {
  const auth = {accessToken:async()=> 'secret'};
  const api = new SteamApi(auth,async()=>response({},429,{'Retry-After':'1800'}));
  await assert.rejects(()=>api.library('1','english'),{code:'RATE_LIMIT',retryAfterSeconds:1800});
  api.fetch=async()=>response({response:{}});
  await assert.rejects(()=>api.library('1','english'),{code:'INVALID_RESPONSE'});
  api.fetch=async()=>response({response:{apps:[]}},200,{'x-eresult':'84'});
  await assert.rejects(()=>api.library('1','english'),{code:'RATE_LIMIT'});
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:01:00 GMT',0),60);
  assert.equal(nextDelay(config,1,{retryAfterSeconds:1800},()=>0),1800);
  assert.equal(nextDelay(config,9,null,()=>0),3600);
});

test('expired access token refreshes once; API parameters retain SteamID64 precision', async () => {
  let renew=0,calls=0;
  const auth = {steamid:'76561198000000001',accessToken:async force=>{if(force)renew++;return 'secret';}};
  const api = new SteamApi(auth,async url=>{
    const params=JSON.parse(url.searchParams.get('input_json'));
    assert.equal(params.family_groupid,'12345678901234567890');
    assert.equal(params.include_excluded,true);
    assert.equal(params.include_own,true);
    return ++calls===1 ? response({},401) : response({response:{apps:[]}});
  });
  assert.deepEqual(await api.library('12345678901234567890','schinese'),[]);
  assert.equal(renew,1); assert.equal(calls,2);
  calls=0;
  api.fetch=async()=>{calls++;return response({},401);};
  await assert.rejects(()=>api.library('1','english'),{code:'AUTH_REQUIRED'});
  assert.equal(calls,2);
});

test('bot requests never initiate Steam scans; scan failures preserve baseline and expand time interval', async () => {
  const db = new Store();
  let fail=false,libraryCalls=0;
  const api = {
    auth:{steamid:'76561198000000001',accessToken:async()=> 'secret'},
    family:async()=>({id:'1',members:[]}),names:async()=>({}),
    library:async()=>{libraryCalls++; if(fail)throw new Error('network');return [{appid:10,name:'x'}];},
  };
  const monitor = new Monitor(db,api,config,()=>{});
  await monitor.scanOnce(); db.register('A');
  const at=db.status().last_success_at;
  db.changes('A'); db.changes('A'); assert.equal(libraryCalls,1);
  fail=true; await assert.rejects(()=>monitor.scanOnce());
  assert.equal(db.status().last_success_at,at);
  db.close();
});
