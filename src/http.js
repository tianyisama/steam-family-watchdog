import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { ApiError } from './store.js';

function authorized(request, secret) {
  const actual = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function bodyJson(request) {
  if (!request.headers['content-type']?.split(';')[0].trim().includes('application/json'))
    throw new ApiError(415, 'json_required', 'POST 请求需要 Content-Type: application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32768) throw new ApiError(413, 'body_too_large', '请求内容超过 32 KB');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, 'invalid_json', '需要有效的 JSON 对象'); }
}

const clientTag = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
  ? value : '-';

export function createServer(store, monitor, auth, secret, log = console.log) {
  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestId = randomUUID().slice(0, 8);
    let route = '-';
    let clientid = '-';
    let result = {};
    let finished = false;
    response.once('finish', () => {
      finished = true;
      const fields = [
        `[HTTP] ${new Date().toISOString()} 响应 id=${requestId}`,
        `${request.method} ${route}`, `clientid=${clientid}`,
        `status=${response.statusCode}`, `耗时=${Date.now() - startedAt}ms`,
      ];
      if (Number.isInteger(result.count)) fields.push(`待通知=${result.count}`);
      if (Number.isInteger(result.cursor)) fields.push(`已确认位置=${result.cursor}`);
      if (typeof result.client_created === 'boolean') fields.push(`新客户端=${result.client_created}`);
      if (result.delivery_id) fields.push(`批次=${result.delivery_id}`);
      if (result.error) fields.push(`错误=${result.error}`);
      log(fields.join(' '));
    });
    response.once('close', () => {
      if (!finished) log(`[HTTP] ${new Date().toISOString()} 连接提前断开 id=${requestId} ${request.method} ${route} clientid=${clientid}`);
    });
    const send = (status, body) => {
      result = body;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      // Only log recognized routes and client IDs, never raw URLs, headers,
      // body contents, passwords, API secrets or Steam tokens.
      route = ['/health', '/status', '/games', '/changes', '/clients', '/ack'].includes(url.pathname)
        ? url.pathname : '[unknown_route]';
      clientid = clientTag(url.searchParams.get('clientid'));
      log(`[HTTP] ${new Date().toISOString()} 收到请求 id=${requestId} ${request.method} ${route} clientid=${clientid}`);
      if (request.method === 'GET' && url.pathname === '/health')
        return send(200, { service: 'Steam Family Monitor', alive: true });
      if (!authorized(request, secret)) return send(401, { success: false, error: 'unauthorized', message: '需要正确的 Bearer 接口密钥' });
      if (request.method === 'GET' && url.pathname === '/status')
        return send(200, { success: true, ...store.status(), ...monitor.status, scanning: monitor.running, auth_state: auth.state, steamid: auth.steamid });
      if (request.method === 'GET' && url.pathname === '/games')
        return send(200, { success: true, family_groupid: store.meta('active_family'), games: store.games() });
      if (url.pathname === '/changes' && ['GET', 'POST'].includes(request.method)) {
        const params = request.method === 'POST' ? await bodyJson(request) : Object.fromEntries(url.searchParams);
        clientid = clientTag(params.clientid);
        const data = store.changes(params.clientid, params.limit === undefined ? 10 : Number(params.limit));
        return send(200, { ...data, last_success_at: store.meta('last_success_at'), monitor_error: monitor.status.last_error });
      }
      if (request.method === 'POST' && url.pathname === '/clients') {
        const params = await bodyJson(request);
        clientid = clientTag(params.clientid);
        return send(200, { success: true, clientid: params.clientid, ...store.register(params.clientid, params.start ?? 'latest') });
      }
      if (request.method === 'POST' && url.pathname === '/ack') {
        const params = await bodyJson(request);
        clientid = clientTag(params.clientid);
        return send(200, { clientid: params.clientid, ...store.ack(params.clientid, params.delivery_id) });
      }
      return send(404, { success: false, error: 'not_found', message: '接口不存在' });
    } catch (error) {
      if (error instanceof ApiError) send(error.status, { success: false, error: error.code, message: error.message });
      else send(500, { success: false, error: 'internal_error', message: '本地处理失败，请检查服务端状态' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
