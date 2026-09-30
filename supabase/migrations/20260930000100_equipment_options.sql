-- =====================================================================
-- 装備オプション (家電・集客セット) の再開
--   * 公開カタログのオプションに extra.includes (セットに含まれる品目の id の配列) を含める
--     (家電セット OP010 は OP001〜OP009 を含む。予約画面で、家電セットを選んだら中の品目を
--      選べなくするため。料金の判定はサーバーが DB の値で行う)
--   * extra の他の項目は引き続き出さない。includes は配列のときだけ出す
--   ※ 000600 の定義を引き継ぐ (権限・security definer・search_path・stable は同じ)
--   * options.kind の既定値を 'other' (装備) にする。補償は料金表の4件 (seed で kind='cover' を指定) だけで、
--     管理画面から種類を指定せずに追加したオプションが「補償」として表示されないようにする
--     (画面は kind = 'cover' 以外を装備オプションとして表示する。デモの kind の無いオプションも同じ扱い)
--   オプションの行そのもの (OP001〜OP011) は supabase/seed.sql で入れる。
-- =====================================================================
alter table public.options alter column kind set default 'other';

create or replace function public.public_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(to_jsonb(c) order by c.sort, c.id)
                            from public.categories c where c.active), '[]'::jsonb),
    'locations',  coalesce((select jsonb_agg(to_jsonb(l) order by l.sort, l.id)
                            from public.locations l where l.active), '[]'::jsonb),
    'assets',     coalesce((select jsonb_agg(to_jsonb(a) - 'plate' - 'shaken_date' - 'maintenance_date' - 'extra'
                                             order by a.sort, a.id)
                            from public.assets a
                            join public.categories c on c.id = a.category_id and c.active
                            where a.active), '[]'::jsonb),
    'options',    coalesce((select jsonb_agg((to_jsonb(o) - 'extra')
                                             || jsonb_build_object('extra', jsonb_strip_nulls(jsonb_build_object(
                                                  'description', o.extra ->> 'description',
                                                  'includes', case when jsonb_typeof(o.extra -> 'includes') = 'array'
                                                                   then o.extra -> 'includes' end)))
                                             order by o.sort, o.id)
                            from public.options o where o.active), '[]'::jsonb),
    'settings',   coalesce((select jsonb_object_agg(s.key, s.value)
                            from public.app_settings s where public.is_public_setting(s.key)), '{}'::jsonb),
    'collections', coalesce((select jsonb_object_agg(x.collection, x.items) from (
                              select ac.collection, jsonb_agg(ac.data order by ac.sort, ac.id) as items
                              from public.app_collections ac
                              where public.is_public_collection(ac.collection)
                              group by ac.collection) x), '{}'::jsonb),
    'legal',      coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'version', d.version, 'title', d.title,
                                                                'url', d.url, 'effectiveAt', d.effective_at) order by d.id)
                            from public.legal_documents d where d.active), '[]'::jsonb),
    'serverTime', to_jsonb(now())
  )
$$;
revoke execute on function public.public_catalog() from public;
grant execute on function public.public_catalog() to anon, authenticated;
