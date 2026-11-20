# mtou 단축 URL

긴 주소를 `https://mtou.kr/Ab3x7` 처럼 짧게 줄여 주는 단축 URL 서비스입니다.
`mtou`는 도메인 이름에 넣고, 경로에는 5자리 코드만 붙여 최대한 짧게 만듭니다.
외부 패키지 없이 Node.js 내장 모듈만 사용합니다. 링크는 Supabase(배포) 또는 로컬 SQLite 파일(개발)에 저장됩니다.

## 기능
- URL 단축 (프로토콜 생략 시 `https://` 자동 보충, http/https만 허용)
- 원하는 별칭 지정: `mtou.kr/my-link` (영문·숫자·`-`·`_` 3~30자)
- 같은 URL은 같은 단축 주소 재사용
- QR 코드 자동 생성 및 저장
- 클릭 통계: 단축 주소 뒤에 `+` → `mtou.kr/Ab3x7+`
- 최근 만든 주소 목록 (브라우저 저장)
- IP당 분당 30회 생성 제한, 자기 단축 주소 재단축 차단

## 실행
Node.js 22.13 이상이 필요합니다.

```bash
cd shorturl
npm start
```

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 서버 포트 |
| `BASE_URL` | `http://localhost:PORT` | 단축 주소에 쓰일 도메인 (예: `https://mtou.kr`, `https://mtou.onrender.com`) |
| `PREFIX` | (없음) | 경로에도 넣고 싶을 때 (예: `mtou` → `도메인/mtou/Ab3x7`) |
| `DATA_DIR` | `./data` | SQLite DB 저장 위치 (Supabase 미설정 시) |
| `SUPABASE_URL` | (없음) | Supabase 프로젝트 URL |
| `SUPABASE_KEY` | (없음) | Supabase anon(public) 키 |
| `TRUST_PROXY` | (없음) | `1`이면 X-Forwarded-For로 실제 IP 판단 (Render 등) |

## API
- `POST /api/shorten` `{ "url": "...", "alias": "선택" }` → `{ code, shortUrl, url }`
- `GET /api/stats/:code` → `{ code, shortUrl, url, clicks, createdAt, lastClick }`
- `GET /:code` → 원래 주소로 302 리다이렉트

## 테스트
```bash
npm test
```

## 배포 (Render + Supabase)
1. Supabase 대시보드 > SQL Editor 에서 `supabase.sql` 실행 (테이블 `mtou_links`와 함수 생성)
2. Render 에서 New > Blueprint 로 이 저장소를 연결하면 루트의 `render.yaml` 대로 `mtou` 서비스가 만들어집니다.
3. `SUPABASE_KEY` 에 anon(public) 키 입력 → 배포 완료 후 `https://mtou.onrender.com`
4. 확인: `https://mtou.onrender.com/healthz` 가 `{"ok":true,"store":"supabase"}` 이면 정상

무료 플랜은 15분간 요청이 없으면 잠들고, 첫 요청 때 깨어나는 데 수십 초가 걸릴 수 있습니다.
