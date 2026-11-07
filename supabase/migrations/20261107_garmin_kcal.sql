-- Dagens forbrænding fra den officielle Garmin API.
alter table public.garmin_off_daily add column if not exists kcal_total numeric, add column if not exists kcal_active numeric, add column if not exists kcal_bmr numeric;

-- garmin_daily.kcal_* er genererede kolonner (fra raw.stats). Funktionen fletter nøgler ind i raw.stats.
create or replace function public.set_stats(p_date date, p_stats jsonb) returns void
language sql security definer set search_path = public as $$
  update public.garmin_daily
     set raw = jsonb_set(coalesce(raw, '{}'::jsonb), '{stats}', coalesce(raw->'stats', '{}'::jsonb) || p_stats),
         updated_at = now()
   where log_date = p_date;
$$;
revoke all on function public.set_stats(date, jsonb) from public, anon, authenticated;
grant execute on function public.set_stats(date, jsonb) to service_role;
