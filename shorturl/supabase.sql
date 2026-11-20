-- mtou 단축 URL — Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행하면 됩니다. (여러 번 실행해도 안전)
-- 테이블은 RLS로 직접 접근을 막고, 서버는 anon 키로 아래 함수만 호출합니다.

create table if not exists public.mtou_links (
  code        text primary key check (code ~ '^[A-Za-z0-9_-]{3,30}$'),
  url         text not null check (url ~* '^https?://' and length(url) <= 2048),
  created_at  timestamptz not null default now(),
  clicks      bigint not null default 0,
  last_click  timestamptz,
  is_custom   boolean not null default false
);
create index if not exists mtou_links_url_idx on public.mtou_links (url) where not is_custom;

alter table public.mtou_links enable row level security;
revoke all on public.mtou_links from anon, authenticated;

-- 단축 주소 생성. 자동 코드(p_custom=false)면 같은 URL의 기존 코드를 재사용.
-- 반환: code (이미 있는 별칭이면 status='taken')
create or replace function public.mtou_create(p_code text, p_url text, p_custom boolean)
returns table(code text, url text, status text)
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not p_custom then
    select l.code into v_code from mtou_links l where l.url = p_url and not l.is_custom limit 1;
    if found then return query select v_code, p_url, 'exists'::text; return; end if;
  end if;
  begin
    insert into mtou_links (code, url, is_custom) values (p_code, p_url, p_custom);
    return query select p_code, p_url, 'created'::text;
  exception when unique_violation then
    return query select p_code, p_url, 'taken'::text;
  end;
end $$;

-- 리다이렉트용: 클릭 수 +1 하고 원래 URL 반환 (없으면 null)
create or replace function public.mtou_hit(p_code text)
returns text
language sql security definer set search_path = public as $$
  update mtou_links set clicks = clicks + 1, last_click = now()
  where code = p_code returning url;
$$;

-- 통계 조회
create or replace function public.mtou_get(p_code text)
returns table(code text, url text, clicks bigint, created_at timestamptz, last_click timestamptz)
language sql stable security definer set search_path = public as $$
  select code, url, clicks, created_at, last_click from mtou_links where code = p_code;
$$;

-- 전체 합계
create or replace function public.mtou_totals()
returns table(n bigint, c bigint)
language sql stable security definer set search_path = public as $$
  select count(*), coalesce(sum(clicks), 0) from mtou_links;
$$;

revoke all on function public.mtou_create(text, text, boolean), public.mtou_hit(text),
  public.mtou_get(text), public.mtou_totals() from public;
grant execute on function public.mtou_create(text, text, boolean), public.mtou_hit(text),
  public.mtou_get(text), public.mtou_totals() to anon, authenticated;
