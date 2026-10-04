import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import steamSession from 'steam-session';
import { loadConfig, atomicJson, acquireLock } from './config.js';

const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = steamSession;
const config = loadConfig();
const release = acquireLock(config.dataDir);
const port = Number(process.env.MONITOR_LOGIN_PORT || 11453);
if (!Number.isInteger(port) || port < 1 || port > 65535) { release(); throw new Error('登录端口无效'); }
const origin = `http://127.0.0.1:${port}`;
const csrf = randomBytes(32).toString('hex');
let session = null;
let busy = false;
let attempts = 0;
let blockedUntil = 0;
let loginCooldown = 0;
let state = { stage: 'idle', message: '输入 Steam 账号和密码，再使用 Steam++ 的动态验证码完成验证。' };
let server;

function publicError(error) {
  const code = Number(error.eresult);
  if ([25,84].includes(code)) {
    blockedUntil = Date.now() + 15 * 60_000;
    return 'Steam 暂时限制了登录请求，请 15 分钟后重试。';
  }
  if (code === 5) return '账号或密码不正确，请检查后重试。';
  if ([65,88].includes(code)) return '验证码不正确或已过期，请使用 Steam++ 当前显示的验证码。';
  return '登录暂未成功，请检查账号、验证码或网络后重试。';
}

function attachEvents(current) {
  current.on('authenticated', () => {
    if (session !== current) return;
    try {
      atomicJson(path.join(config.dataDir, 'auth.json'), {
        platform: 'MobileApp', steamid: current.steamID.getSteamID64(),
        refresh_token: current.refreshToken, saved_at: new Date().toISOString(),
      });
      state = { stage: 'authenticated', message: '登录成功，凭据已保存。可以关闭此页面。' };
      console.log('Steam 登录成功；长期凭据已保存。');
      // Keep status visible briefly; then release the lock for the monitor.
      setTimeout(shutdown, 10_000);
    } catch { state = { stage: 'error', message: '登录成功，但凭据保存失败，请检查本机目录权限。' }; }
  });
  current.on('timeout', () => {
    if (session === current) state = { stage: 'error', message: '本次登录已超时，请重新输入账号和密码。' };
  });
  current.on('error', error => {
    if (session === current) state = { stage: 'error', message: publicError(error) };
  });
}

async function readJson(request) {
  let size = 0;
  const parts = [];
  for await (const part of request) {
    size += part.length;
    if (size > 8192) throw new Error('body too big');
    parts.push(part);
  }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid body');
  return value;
}

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Steam 家庭库登录</title>
<style>body{font:16px system-ui,sans-serif;background:#111827;color:#e5e7eb;margin:0;padding:36px 16px}main{max-width:480px;margin:0 auto;background:#1f2937;border:1px solid #374151;border-radius:18px;padding:28px}h1{font-size:25px;margin-top:0}p{line-height:1.7;color:#bdc9da}label{display:block;margin:18px 0 8px}input,button{box-sizing:border-box;width:100%;padding:12px;font:inherit;border-radius:8px}input{background:#111827;color:white;border:1px solid #59677a}button{margin-top:20px;background:#38bdf8;color:#082f49;border:0;font-weight:600;cursor:pointer}button:disabled{opacity:.5}#status{white-space:pre-wrap;min-height:48px;color:#a5e7ff}small{color:#9ca3af}#guard{display:none}</style>
<main><h1>登录 Steam 家庭库</h1><p>使用 Steam 账号密码，以及 Steam++（Watt Toolkit）中显示的动态验证码。此页面只在本机提供；密码与验证码不会保存。</p>
<form id="account" autocomplete="off"><label for="name">Steam 登录账号</label><input id="name" autocomplete="username" required><label for="password">密码</label><input id="password" type="password" autocomplete="off" required><label for="firstcode">Steam++ 动态验证码（可选）</label><input id="firstcode" maxlength="8" autocomplete="off" placeholder="例如 ABCDE；也可以下一步输入"><button id="login">登录</button></form>
<form id="guard" autocomplete="off"><label for="code">验证码</label><input id="code" maxlength="8" required autocomplete="one-time-code" placeholder="输入当前显示的验证码"><button id="submitcode">提交验证码</button></form>
<p id="status"></p><small>验证码会定时变化，请及时提交。若 Steam 要求邮箱验证，请输入收到的邮箱验证码。</small></main>
<script>
const csrf=${JSON.stringify(csrf)};
const el=id=>document.getElementById(id);
let finished=false;
function render(s){el('status').textContent=s.message;el('guard').style.display=['awaiting_code','awaiting_confirmation'].includes(s.stage)?'block':'none';if(s.stage==='authenticated'){finished=true;el('account').style.display='none';el('guard').style.display='none';}}
async function submit(route,data){el('login').disabled=true;el('submitcode').disabled=true;try{const r=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json','X-Login-CSRF':csrf},body:JSON.stringify(data)});render(await r.json());}catch{el('status').textContent='本地登录服务未连接。若尚未成功，请重新启动登录程序。';}finally{el('password').value='';el('firstcode').value='';el('code').value='';el('login').disabled=false;el('submitcode').disabled=false;}}
el('account').addEventListener('submit',e=>{e.preventDefault();submit('/login',{accountName:el('name').value,password:el('password').value,code:el('firstcode').value});});
el('guard').addEventListener('submit',e=>{e.preventDefault();submit('/code',{code:el('code').value});});
async function poll(){if(finished)return;try{const r=await fetch('/state',{headers:{'X-Login-CSRF':csrf}});render(await r.json());}catch{}setTimeout(poll,2000);}poll();
</script></html>`;

server = http.createServer(async (request,response) => {
  const headers = {
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
  };
  const send = (status,data) => {
    response.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8'});
    response.end(JSON.stringify(data));
  };
  if (request.headers.host !== `127.0.0.1:${port}`) return send(403,{message:'请使用本机 127.0.0.1 地址打开登录页面。'});
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8'}); response.end(page); return;
  }
  const received = Buffer.from(request.headers['x-login-csrf'] || '');
  const expected = Buffer.from(csrf);
  if (received.length !== expected.length || !timingSafeEqual(received,expected)
      || (request.headers.origin && request.headers.origin !== origin)) return send(403,{message:'请求验证失败，请重新打开登录页面。'});
  if (request.method === 'GET' && request.url === '/state') return send(200,state);
  if (request.method !== 'POST' || !['/login','/code'].includes(request.url)) return send(404,{message:'页面不存在。'});
  if (busy || state.stage === 'authenticated') return send(409,state);
  if (Date.now() < blockedUntil || (request.url === '/login' && Date.now() < loginCooldown))
    return send(429,{...state,message:'请稍后重试登录，避免连续提交。'});
  busy = true;
  try {
    const body = await readJson(request);
    if (request.url === '/login') {
      if (typeof body.accountName !== 'string' || !body.accountName.trim() || body.accountName.length > 128
          || typeof body.password !== 'string' || !body.password || body.password.length > 256) return send(400,{stage:'error',message:'请填写正确的账号与密码。'});
      if (session) session.cancelLoginAttempt();
      const current = new LoginSession(EAuthTokenPlatformType.MobileApp);
      current.loginTimeout = 180_000; session = current; attempts = 0;
      attachEvents(current);
      state = {stage:'working',message:'正在连接 Steam…'};
      loginCooldown = Date.now() + 10_000;
      const details = { accountName:body.accountName.trim(), password:body.password };
      if (typeof body.code === 'string' && body.code.trim()) details.steamGuardCode = body.code.trim().toUpperCase();
      let result;
      try { result = await current.startWithCredentials(details); }
      finally { details.password = ''; body.password = ''; }
      if (state.stage !== 'authenticated') {
        if (result.validActions?.some(action => [EAuthSessionGuardType.DeviceCode,EAuthSessionGuardType.EmailCode].includes(action.type)))
          state = {stage:'awaiting_code',message:'请填写 Steam++ 当前显示的动态验证码；若账号使用邮箱验证，请填写邮箱验证码。'};
        else if (result.actionRequired) state = {stage:'awaiting_confirmation',message:'Steam 要求登录确认。如果支持验证码，也可以在下方输入；否则请确认 Steam 提示的验证方式。'};
        else state = {stage:'working',message:'正在完成登录，请稍候…'};
      }
    } else {
      if (!session || !['awaiting_code','awaiting_confirmation'].includes(state.stage)) return send(400,{stage:'error',message:'请先提交账号和密码。'});
      if (typeof body.code !== 'string' || !/^[A-Za-z0-9]{5,8}$/.test(body.code.trim())) return send(400,{...state,message:'请填写正确的验证码。'});
      if (++attempts > 3) { blockedUntil=Date.now()+60_000; return send(429,{...state,message:'验证码尝试较多，请等待一分钟后重新开始登录。'}); }
      await session.submitSteamGuardCode(body.code.trim().toUpperCase());
      if (state.stage !== 'authenticated') state={stage:'working',message:'验证码已提交，等待 Steam 完成登录…'};
    }
    send(200,state);
  } catch (error) {
    const message = publicError(error);
    state={stage:request.url==='/code' && [65,88].includes(Number(error.eresult))?'awaiting_code':'error',message};
    send(400,state);
  } finally { busy=false; }
});
server.headersTimeout=10_000; server.requestTimeout=15_000;
const expiry = setTimeout(() => { console.log('本地登录页面已超时关闭，请重新运行 npm run login。'); shutdown(); },10*60_000);
let closing=false;
function shutdown() {
  if (closing) return;
  closing=true; clearTimeout(expiry);
  if (session && state.stage!=='authenticated') session.cancelLoginAttempt();
  server.close(()=>release());
}
server.on('error', error=>{
  console.error(`本地登录页面无法启动：${error.code || 'UNKNOWN'}。请检查端口或先停止后端。`);
  clearTimeout(expiry);release();process.exitCode=1;
});
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
server.listen(port,'127.0.0.1',()=>console.log(`请在本机浏览器打开 ${origin}，使用 Steam++ 动态验证码登录。`));
