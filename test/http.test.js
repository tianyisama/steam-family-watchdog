import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/http.js';

test('HTTP API enforces authentication, accepts GET/POST, and ACK advances only its own client', async () => {
  const store = new Store();
  const monitor = {status:{last_error:null},running:false};
  const logs = [];
  const server = createServer(store,monitor,{state:'test',steamid:null},'test-secret',line=>logs.push(line));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url,body) => fetch(base+url,{
    method: body === undefined ? 'GET' : 'POST',
    headers: {'Authorization':'Bearer test-secret','Content-Type':'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(base+'/status')).status,401);
    assert.equal((await fetch(base+'/health')).status,200);
    assert.equal((await request('/changes?clientid=A')).status,503);
    const game = appid=>({appid,name:`游戏${appid}`,owner_steamids:['76561198000000001']});
    store.scan('1',[game(10)],'2026-10-04T16:00:00Z');
    assert.equal((await (await request('/clients',{clientid:'A'})).json()).created,true);
    await request('/changes?clientid=B');
    store.scan('1',[game(10),game(20)],'2026-10-04T16:05:00Z');
    const batch = await (await request('/changes',{clientid:'A',limit:5})).json();
    assert.equal(batch.count,1);
    assert.deepEqual(await (await request('/changes?clientid=A')).json(),batch);
    assert.equal((await request('/ack',{clientid:'A',delivery_id:'wrong'})).status,409);
    assert.equal((await request('/ack',{clientid:'A',delivery_id:batch.delivery_id})).status,200);
    assert.equal((await (await request('/changes?clientid=A')).json()).count,0);
    assert.equal((await (await request('/changes?clientid=B')).json()).count,1);
    assert.equal((await request('/changes?clientid=A&limit=garbage')).status,400);
    const status = await (await request('/status')).json();
    assert.equal(status.baseline_ready,true);
    assert.equal(JSON.stringify(status).includes('test-secret'),false);
    assert.ok(logs.some(line=>line.includes('收到请求') && line.includes('GET /changes')));
    assert.ok(logs.some(line=>line.includes('响应') && line.includes('POST /changes') && line.includes('clientid=A') && line.includes('待通知=1')));
    assert.ok(logs.some(line=>line.includes('响应') && line.includes('status=401')));
    await request('/status?access_token=never-log-this&password=never-log-this');
    assert.equal(logs.join('\n').includes('test-secret'),false);
    assert.equal(logs.join('\n').includes('never-log-this'),false);
  } finally { await new Promise(resolve=>server.close(resolve)); store.close(); }
});
