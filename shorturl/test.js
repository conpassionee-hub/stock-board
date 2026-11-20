'use strict';
// 간단한 통합 테스트: node test.js
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtou-test-'));
process.env.PORT = '0';
const { server } = require('./server');

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + '/api/shorten', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // 1) 기본 단축 — 도메인/5자리 코드
  let r = await post({ url: 'example.com/some/long/path?q=1' });
  assert.equal(r.status, 201);
  let d = await r.json();
  assert.match(d.shortUrl, /:\d+\/[A-Za-z0-9]{5}$/);
  assert.equal(d.url, 'https://example.com/some/long/path?q=1');

  // 2) 같은 URL은 같은 코드 재사용
  const again = await (await post({ url: 'https://example.com/some/long/path?q=1' })).json();
  assert.equal(again.code, d.code);

  // 3) 리다이렉트 + 클릭 수 증가
  r = await fetch(`${base}/${d.code}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), d.url);
  const st = await (await fetch(`${base}/api/stats/${d.code}`)).json();
  assert.equal(st.clicks, 1);

  // 4) 사용자 지정 별칭 + 중복 거절
  r = await post({ url: 'https://naver.com', alias: 'my-link' });
  assert.equal(r.status, 201);
  assert.match((await r.json()).shortUrl, /:\d+\/my-link$/);
  assert.equal((await post({ url: 'https://daum.net', alias: 'my-link' })).status, 409);
  assert.equal((await post({ url: 'https://daum.net', alias: 'a b' })).status, 400);

  // 5) 잘못된 URL 거절
  for (const bad of ['', 'javascript:alert(1)', 'ftp://x.com', 'notaurl']) {
    assert.equal((await post({ url: bad })).status, 400, bad);
  }

  // 6) 없는 코드 → 404, 통계 페이지 / 메인 페이지
  assert.equal((await fetch(`${base}/nope99`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${base}/${d.code}+`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);

  console.log('✓ 모든 테스트 통과');
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
