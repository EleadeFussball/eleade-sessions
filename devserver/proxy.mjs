// Local stand-in for Supabase: /rest/v1 -> PostgREST, a minimal /auth/v1, and /dev/token for test logins.
import http from 'node:http';
import crypto from 'node:crypto';
const SECRET = 'local-dev-secret-local-dev-secret-0123456789';
const USERS = {
  'info@eleadefussball.com': '11111111-1111-4111-8111-111111111111',
  'tyler@test.local': '22222222-2222-4222-8222-222222222222',
  'paul@test.local': '33333333-3333-4333-8333-333333333333',
  'david@test.local': '44444444-4444-4444-8444-444444444444',
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(email) {
  const now = Math.floor(Date.now() / 1000);
  const body = { sub: USERS[email], email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 };
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(body);
  const s = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-expose-headers': 'content-range, content-profile',
};
function json(res, code, obj) { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
const META = {};  // user_metadata per email, kept in memory for local testing
function user(email) { return { id: USERS[email], email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: META[email] || {}, created_at: new Date().toISOString() }; }

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (url.pathname === '/dev/token') {
    const email = url.searchParams.get('email');
    if (!USERS[email]) return json(res, 404, { error: 'unknown' });
    return json(res, 200, { access_token: sign(email), refresh_token: 'r:' + email, token_type: 'bearer', expires_in: 3600, user: user(email) });
  }
  if (url.pathname === '/auth/v1/user') {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    let email; try { email = decode(t).email; } catch { return json(res, 401, { msg: 'bad token' }); }
    if (req.method === 'PUT') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const body = JSON.parse(b || '{}');
        if (body.data) META[email] = { ...(META[email] || {}), ...body.data };
        json(res, 200, user(email));
      });
      return;
    }
    return json(res, 200, user(email));
  }
  if (url.pathname === '/auth/v1/token') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const email = (JSON.parse(b || '{}').refresh_token || '').slice(2);
      if (!USERS[email]) return json(res, 400, { error: 'invalid_grant' });
      json(res, 200, { access_token: sign(email), refresh_token: 'r:' + email, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: user(email) });
    });
    return;
  }
  if (url.pathname.startsWith('/auth/v1/logout')) { res.writeHead(204, cors); return res.end(); }
  if (url.pathname.startsWith('/auth/v1/otp')) return json(res, 200, {});
  if (url.pathname.startsWith('/rest/v1')) {
    const headers = { ...req.headers }; delete headers.host;
    const fwd = http.request({ host: '127.0.0.1', port: 3001, method: req.method, path: url.pathname.slice(8) + url.search, headers }, (r) => {
      res.writeHead(r.statusCode, { ...r.headers, ...cors }); r.pipe(res);
    });
    req.pipe(fwd); fwd.on('error', (e) => json(res, 502, { message: String(e) }));
    return;
  }
  json(res, 404, { error: 'not found', path: url.pathname });
}).listen(54321, () => console.log('proxy on 54321'));
