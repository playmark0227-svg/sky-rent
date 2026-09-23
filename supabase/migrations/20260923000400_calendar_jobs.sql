-- =====================================================================
-- Google カレンダー連携 / 定期ジョブ
--
--   * 担当者の空き状況は Edge Function が Google Calendar API (freeBusy) で取得する。
--     認証情報 (サービスアカウント鍵) は Edge Function の secret にだけ置き、DB には置かない。
--   * 予約の作成・変更・取消のたびに、担当者カレンダーへ「貸出」「返却」の予定を
--     書き込むジョブ (outbox.template = 'gcal_sync') をトリガーで積む。
--     当社が書き込む予定は「予定なし (transparent)」にするので、空き判定には影響しない。
--   * 設定は app_settings.calendar (スタッフのみ閲覧可):
--     {
--       "enabled": false,             連携を使うか
--       "mode": "handover",           handover = 貸出・返却の時刻に担当者が空いているか
--                                      day      = 貸出日・返却日に予定が1件もないか
--       "handoverMinutes": 30,        受け渡しにかかる時間 (分)
--       "oneHandoverAtATime": true,   同じ拠点で受け渡し時刻が近い予約を重ねない
--       "writeEvents": true,          予約を担当者カレンダーに書き込むか
--       "failOpen": false,            Google に接続できないとき予約を受けるか (既定: 受けない)
--       "locations": { "loc-kitami": { "calendarIds": ["..."] }, ... }
--     }
-- =====================================================================

alter table public.reservations
  add column gcal_events jsonb not null default '{}'::jsonb;  -- {"pickup": {...}, "return": {...}}

-- Google から取得した「予定あり」時間帯の短期キャッシュ (Edge Function 専用)
create table public.calendar_cache (
  key        text primary key,
  data       jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.calendar_cache enable row level security;
revoke all on public.calendar_cache from anon, authenticated;

-- 予約の変化をカレンダー同期ジョブとして積む
create or replace function public.enqueue_calendar_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cfg jsonb := public.setting('calendar', '{}'::jsonb);
begin
  if current_setting('skyrent.internal', true) = 'gcal' then return new; end if;
  if new.kind <> 'rental' then return new; end if;
  if not coalesce((cfg ->> 'enabled')::boolean, false) or not coalesce((cfg ->> 'writeEvents')::boolean, true) then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.status is not distinct from new.status
     and old.period is not distinct from new.period
     and old.asset_id is not distinct from new.asset_id
     and old.customer_name is not distinct from new.customer_name
     and old.customer_phone is not distinct from new.customer_phone then
    return new;
  end if;
  -- 未処理の同期ジョブがあれば積み増さない (ワーカーは最新状態を読んで反映する)
  if not exists (select 1 from public.outbox o
                  where o.template = 'gcal_sync' and o.ref_id = new.id and o.status in ('pending', 'failed')) then
    insert into public.outbox (template, to_email, payload, ref_type, ref_id)
    values ('gcal_sync', 'google-calendar', jsonb_build_object('reservation_id', new.id), 'reservation', new.id);
  end if;
  return new;
end $$;

create trigger reservations_calendar_sync
  after insert or update on public.reservations
  for each row execute function public.enqueue_calendar_sync();

-- ワーカーがカレンダー予定IDを保存する。
--   version / updated_at / 監査 / 同期ジョブを発火させないよう、トランザクション内だけ
--   有効な設定 skyrent.internal = 'gcal' を立ててから更新する (各トリガーがこれを見て素通りする)
create or replace function public.set_reservation_gcal_events(p_id text, p_events jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('skyrent.internal', 'gcal', true);
  update public.reservations set gcal_events = coalesce(p_events, '{}'::jsonb) where id = p_id;
  perform set_config('skyrent.internal', '', true);
end $$;

revoke execute on function public.enqueue_calendar_sync() from public, anon, authenticated;
revoke execute on function public.set_reservation_gcal_events(text, jsonb) from public, anon, authenticated;
grant execute on function public.set_reservation_gcal_events(text, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 定期ジョブ (pg_cron が使える環境だけ登録。無い環境ではスキップ)
--   * ポイント失効: 毎日 03:10 (JST) = 18:10 UTC
--   * 送信中のまま止まったジョブの解放: 10分ごと
--   メール送信・カレンダー同期のワーカー (Edge Function) の定期起動は、
--   URL とキーが環境ごとに違うので docs/production/setup.md の手順で登録する。
-- ---------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('skyrent-expire-points', '10 18 * * *', 'select public.expire_points()');
  perform cron.schedule('skyrent-outbox-release', '*/10 * * * *', 'select public.outbox_release_stuck()');
exception when others then
  raise notice 'pg_cron が使えないため定期ジョブの登録をスキップしました: %', sqlerrm;
end $$;
