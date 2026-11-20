'use strict';
// 링크 저장소. SUPABASE_URL/SUPABASE_KEY 가 있으면 Supabase, 없으면 로컬 SQLite 파일.
// 공통 인터페이스 (모두 async):
//   create(code, url, isCustom) -> { code, status: 'created' | 'exists' | 'taken' }
//   hit(code)    -> url | null      (클릭 수 +1)
//   get(code)    -> { code, url, clicks, createdAt, lastClick } | null
//   totals()     -> { n, c }

function supabaseStore(baseUrl, key) {
  const endpoint = baseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/';
  async function rpc(fn, args) {
    const r = await fetch(endpoint + fn, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase ${fn} ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  const ms = (t) => (t ? Date.parse(t) : null);
  return {
    kind: 'supabase',
    async create(code, url, isCustom) {
      const [row] = await rpc('mtou_create', { p_code: code, p_url: url, p_custom: !!isCustom });
      return { code: row.code, status: row.status };
    },
    async hit(code) { return (await rpc('mtou_hit', { p_code: code })) || null; },
    async get(code) {
      const [row] = await rpc('mtou_get', { p_code: code });
      return row ? { code: row.code, url: row.url, clicks: Number(row.clicks), createdAt: ms(row.created_at), lastClick: ms(row.last_click) } : null;
    },
    async totals() {
      const [row] = await rpc('mtou_totals');
      return { n: Number(row?.n || 0), c: Number(row?.c || 0) };
    },
  };
}

function sqliteStore(dataDir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'links.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS links (
      code TEXT PRIMARY KEY, url TEXT NOT NULL, created_at INTEGER NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0, last_click INTEGER, is_custom INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_links_url ON links(url);
  `);
  const q = {
    get: db.prepare('SELECT * FROM links WHERE code = ?'),
    findAuto: db.prepare('SELECT code FROM links WHERE url = ? AND is_custom = 0 LIMIT 1'),
    insert: db.prepare('INSERT INTO links (code, url, created_at, is_custom) VALUES (?, ?, ?, ?)'),
    hit: db.prepare('UPDATE links SET clicks = clicks + 1, last_click = ? WHERE code = ? RETURNING url'),
    total: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(clicks),0) AS c FROM links'),
  };
  return {
    kind: 'sqlite',
    async create(code, url, isCustom) {
      if (!isCustom) {
        const ex = q.findAuto.get(url);
        if (ex) return { code: ex.code, status: 'exists' };
      }
      try { q.insert.run(code, url, Date.now(), isCustom ? 1 : 0); return { code, status: 'created' }; }
      catch (e) { if (String(e.message).includes('UNIQUE')) return { code, status: 'taken' }; throw e; }
    },
    async hit(code) { return q.hit.get(Date.now(), code)?.url || null; },
    async get(code) {
      const r = q.get.get(code);
      return r ? { code: r.code, url: r.url, clicks: r.clicks, createdAt: r.created_at, lastClick: r.last_click } : null;
    },
    async totals() { const r = q.total.get(); return { n: r.n, c: r.c }; },
  };
}

module.exports = function createStore({ supabaseUrl, supabaseKey, dataDir }) {
  return supabaseUrl && supabaseKey ? supabaseStore(supabaseUrl, supabaseKey) : sqliteStore(dataDir);
};
