'use strict';
// mtou 단축 URL 서버 — 외부 의존성 없이 Node.js 내장 모듈만 사용 (Node 22.13+)
// 저장소: SUPABASE_URL/SUPABASE_KEY 가 있으면 Supabase, 없으면 로컬 SQLite (store.js)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const createStore = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// 단축 주소: BASE_URL/<code>  (mtou는 도메인에 넣는 것을 권장. 예: https://mtou.kr/Ab3x7)
// 경로에 넣고 싶으면 PREFIX=mtou → BASE_URL/mtou/<code>
const PREFIX = (process.env.PREFIX || '').replace(/^\/+|\/+$/g, '');
const P = PREFIX ? `/${PREFIX}` : '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const CODE_LEN = 5; // 57^5 ≈ 6억 개 조합
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // 헷갈리는 문자(0,O,1,l,I) 제외
const ALIAS_RE = /^[A-Za-z0-9_-]{3,30}$/;
const RESERVED = new Set(['api', 'stats', 'admin', 'static', 'index', 'favicon', 'style', 'qrcode', '404']);
const MAX_URL_LEN = 2048;

// ---------- DB ----------
const store = createStore({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  dataDir: DATA_DIR,
});

// ---------- helpers ----------
function randomCode(len = CODE_LEN) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || s.length > MAX_URL_LEN) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s; // 프로토콜 생략 시 https 보충
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
  // 자기 자신의 단축 주소를 다시 줄이는 것 방지 (무한 리다이렉트 방지)
  try {
    const base = new URL(BASE_URL);
    if (u.host === base.host) return null;
  } catch { /* ignore */ }
  return u.toString();
}

const shortUrl = (code) => `${BASE_URL}${P}/${code}`;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 간단한 IP별 요청 제한 (분당 30회 생성)
const rate = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = 60_000, max = 30;
  const arr = (rate.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  rate.set(ip, arr);
  return arr.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of rate) if (!arr.some((t) => now - t < 60_000)) rate.delete(ip);
}, 60_000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.json': 'application/json',
};
function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  fs.readFile(full, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

function notFound(res) {
  fs.readFile(path.join(PUBLIC_DIR, '404.html'), (err, data) => {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(err ? 'Not Found' : data);
  });
}

// ---------- handlers ----------
async function handleShorten(req, res) {
  // Render 등 프록시 뒤에서는 X-Forwarded-For 의 첫 번째 값이 실제 IP
  const ip = (process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';
  if (rateLimited(ip)) return sendJson(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });

  let data;
  try { data = JSON.parse(await readBody(req) || '{}'); }
  catch { return sendJson(res, 400, { error: '잘못된 요청입니다.' }); }

  const url = normalizeUrl(data.url);
  if (!url) return sendJson(res, 400, { error: '올바른 URL을 입력해 주세요. (http/https)' });

  const alias = typeof data.alias === 'string' ? data.alias.trim() : '';
  if (alias) {
    if (!ALIAS_RE.test(alias)) return sendJson(res, 400, { error: '별칭은 영문·숫자·-·_ 3~30자만 가능합니다.' });
    if (RESERVED.has(alias.toLowerCase())) return sendJson(res, 400, { error: '사용할 수 없는 별칭입니다.' });
    const r = await store.create(alias, url, true);
    if (r.status === 'taken') return sendJson(res, 409, { error: '이미 사용 중인 별칭입니다.' });
    return sendJson(res, 201, { code: alias, shortUrl: shortUrl(alias), url });
  }

  // 같은 URL은 기존 자동 코드를 재사용 (store.create 가 처리)
  for (let i = 0; i < 8; i++) {
    const r = await store.create(randomCode(i < 5 ? CODE_LEN : CODE_LEN + 1), url, false);
    if (r.status !== 'taken') return sendJson(res, r.status === 'created' ? 201 : 200, { code: r.code, shortUrl: shortUrl(r.code), url });
  }
  return sendJson(res, 500, { error: '코드 생성에 실패했습니다. 다시 시도해 주세요.' });
}

async function handleStats(res, code) {
  const row = await store.get(code);
  if (!row) return sendJson(res, 404, { error: '존재하지 않는 단축 주소입니다.' });
  sendJson(res, 200, { ...row, shortUrl: shortUrl(row.code) });
}

async function handleRedirect(res, code) {
  const url = await store.hit(code);
  if (!url) return notFound(res);
  res.writeHead(302, { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'unsafe-url' });
  res.end();
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');

    if (req.method === 'POST' && pathname === '/api/shorten') return await handleShorten(req, res);

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/') return serveStatic(res, 'index.html');
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true, store: store.kind });
      if (pathname === '/api/config') return sendJson(res, 200, { baseUrl: BASE_URL, prefix: PREFIX, ...(await store.totals()) });

      let m;
      if ((m = pathname.match(/^\/api\/stats\/([A-Za-z0-9_-]{1,30})$/))) return await handleStats(res, m[1]);
      // /<code>+  → 통계 페이지,  /<code> → 리다이렉트
      if ((m = pathname.match(new RegExp(`^${P}/([A-Za-z0-9_-]{1,30})\\+$`)))) return serveStatic(res, 'stats.html');
      if ((m = pathname.match(new RegExp(`^${P}/([A-Za-z0-9_-]{1,30})/?$`)))) return await handleRedirect(res, m[1]);
      if (/^\/[\w.-]+\.(css|js|svg|ico|png)$/.test(pathname)) return serveStatic(res, pathname.slice(1));
    }
    notFound(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 오류가 발생했습니다.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`mtou 단축 URL 서버 [${store.kind}]: ${BASE_URL}  (예: ${shortUrl('Ab3x7')})`));
}
module.exports = { server, normalizeUrl };
