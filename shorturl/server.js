'use strict';
// mtou 단축 URL 서버 — 외부 의존성 없이 Node.js 내장 모듈만 사용 (Node 22.13+)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const PREFIX = 'mtou'; // 단축 주소: BASE_URL/mtou/<code>
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const CODE_LEN = 6;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // 헷갈리는 문자(0,O,1,l,I) 제외
const ALIAS_RE = /^[A-Za-z0-9_-]{3,30}$/;
const RESERVED = new Set(['api', 'stats', 'admin', 'static', 'index', 'favicon']);
const MAX_URL_LEN = 2048;

// ---------- DB ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'links.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS links (
    code        TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    clicks      INTEGER NOT NULL DEFAULT 0,
    last_click  INTEGER,
    is_custom   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_links_url ON links(url);
`);
const q = {
  get: db.prepare('SELECT * FROM links WHERE code = ?'),
  findAuto: db.prepare('SELECT code FROM links WHERE url = ? AND is_custom = 0 LIMIT 1'),
  insert: db.prepare('INSERT INTO links (code, url, created_at, is_custom) VALUES (?, ?, ?, ?)'),
  hit: db.prepare('UPDATE links SET clicks = clicks + 1, last_click = ? WHERE code = ?'),
  total: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(clicks),0) AS c FROM links'),
};

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
    if (u.host === base.host && u.pathname.startsWith(`/${PREFIX}/`)) return null;
  } catch { /* ignore */ }
  return u.toString();
}

const shortUrl = (code) => `${BASE_URL}/${PREFIX}/${code}`;

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
  const ip = req.socket.remoteAddress || '';
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
    if (q.get.get(alias)) return sendJson(res, 409, { error: '이미 사용 중인 별칭입니다.' });
    q.insert.run(alias, url, Date.now(), 1);
    return sendJson(res, 201, { code: alias, shortUrl: shortUrl(alias), url });
  }

  // 같은 URL은 기존 자동 코드를 재사용
  const existing = q.findAuto.get(url);
  if (existing) return sendJson(res, 200, { code: existing.code, shortUrl: shortUrl(existing.code), url });

  for (let i = 0; i < 8; i++) {
    const code = randomCode(i < 5 ? CODE_LEN : CODE_LEN + 1);
    try {
      q.insert.run(code, url, Date.now(), 0);
      return sendJson(res, 201, { code, shortUrl: shortUrl(code), url });
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  }
  return sendJson(res, 500, { error: '코드 생성에 실패했습니다. 다시 시도해 주세요.' });
}

function handleStats(res, code) {
  const row = q.get.get(code);
  if (!row) return sendJson(res, 404, { error: '존재하지 않는 단축 주소입니다.' });
  sendJson(res, 200, {
    code: row.code, shortUrl: shortUrl(row.code), url: row.url,
    clicks: row.clicks, createdAt: row.created_at, lastClick: row.last_click,
  });
}

function handleRedirect(res, code) {
  const row = q.get.get(code);
  if (!row) return notFound(res);
  q.hit.run(Date.now(), code);
  res.writeHead(302, { Location: row.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'unsafe-url' });
  res.end();
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');

    if (req.method === 'POST' && pathname === '/api/shorten') return await handleShorten(req, res);

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/') return serveStatic(res, 'index.html');
      if (pathname === '/api/config') return sendJson(res, 200, { baseUrl: BASE_URL, prefix: PREFIX, ...q.total.get() });

      let m;
      if ((m = pathname.match(/^\/api\/stats\/([A-Za-z0-9_-]{1,30})$/))) return handleStats(res, m[1]);
      // /mtou/<code>+  → 통계 페이지,  /mtou/<code> → 리다이렉트
      if ((m = pathname.match(new RegExp(`^/${PREFIX}/([A-Za-z0-9_-]{1,30})\\+$`)))) return serveStatic(res, 'stats.html');
      if ((m = pathname.match(new RegExp(`^/${PREFIX}/([A-Za-z0-9_-]{1,30})/?$`)))) return handleRedirect(res, m[1]);
      if (/^\/[\w.-]+\.(css|js|svg|ico|png)$/.test(pathname)) return serveStatic(res, pathname.slice(1));
    }
    notFound(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 오류가 발생했습니다.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`mtou 단축 URL 서버: ${BASE_URL}  (예: ${BASE_URL}/${PREFIX}/abc123)`));
}
module.exports = { server, normalizeUrl };
