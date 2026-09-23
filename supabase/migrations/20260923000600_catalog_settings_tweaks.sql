-- =====================================================================
-- 公開カタログ・設定の細部
--   * オプションの説明文 (extra.description) を公開カタログに含める
--     (「事故時の免責負担ゼロ (最大5万円)」などを予約画面で見せるため。extra の他の項目は出さない)
--   * 'content' 設定 (トップのお知らせ文など) はコンテンツ担当 (content.write) も保存できる
-- =====================================================================
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
                                             || jsonb_build_object('extra', jsonb_strip_nulls(jsonb_build_object('description', o.extra ->> 'description')))
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

drop policy if exists settings_write on public.app_settings;
create policy settings_write on public.app_settings for all to authenticated
  using (public.has_perm('settings.write') or (key = 'content' and public.has_perm('content.write')))
  with check (public.has_perm('settings.write') or (key = 'content' and public.has_perm('content.write')));
