-- Garmin Personal API (officiel): parallelle tabeller, så de kan sammenlignes med det uofficielle bibliotek før skift.
create table if not exists public.garmin_off_daily (
  log_date date primary key,
  sleep_start timestamptz, sleep_end timestamptz,
  sleep_secs integer, deep_secs integer, light_secs integer, rem_secs integer, awake_secs integer,
  sleep_score integer, hrv_last_night numeric, hrv_status text, resting_hr integer,
  steps integer, stress_avg integer, stress_max integer,
  bb_high integer, bb_low integer, bb_charged integer, bb_drained integer, bb_wake numeric,
  raw jsonb, updated_at timestamptz default now()
);
create table if not exists public.garmin_off_activities (
  activity_id bigint primary key,
  start_local timestamp, log_date date, type text, name text,
  distance_m numeric, duration_s numeric, moving_s numeric, avg_hr numeric, max_hr numeric, calories numeric,
  avg_speed numeric, elevation_gain numeric, training_load numeric, aerobic_te numeric, anaerobic_te numeric,
  vo2max numeric, vo2max_raw numeric,
  laps jsonb, session jsonb, hr_zones jsonb,
  has_fit boolean not null default false, fit_error text,
  raw jsonb, updated_at timestamptz default now()
);
create index if not exists garmin_off_activities_date on public.garmin_off_activities(log_date);

alter table public.garmin_off_daily enable row level security;
alter table public.garmin_off_activities enable row level security;
drop policy if exists "owner only" on public.garmin_off_daily;
drop policy if exists "owner only" on public.garmin_off_activities;
create policy "owner only" on public.garmin_off_daily for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "owner only" on public.garmin_off_activities for all to authenticated using (public.is_owner()) with check (public.is_owner());

create or replace view public.garmin_compare_daily with (security_invoker = true) as
select d.log_date,
  d.sleep_secs u_sleep_secs, o.sleep_secs o_sleep_secs, d.deep_secs u_deep, o.deep_secs o_deep, d.rem_secs u_rem, o.rem_secs o_rem,
  d.sleep_score u_score, o.sleep_score o_score, d.hrv_last_night u_hrv, o.hrv_last_night o_hrv, d.resting_hr u_rhr, o.resting_hr o_rhr,
  d.steps u_steps, o.steps o_steps, d.stress_avg u_stress, o.stress_avg o_stress,
  d.bb_high u_bb_high, o.bb_high o_bb_high, d.bb_low u_bb_low, o.bb_low o_bb_low, d.bb_wake u_bb_wake, o.bb_wake o_bb_wake
from public.garmin_daily d join public.garmin_off_daily o using (log_date);

create or replace view public.garmin_compare_activities with (security_invoker = true) as
select a.activity_id, a.log_date,
  a.distance_m u_dist, o.distance_m o_dist, a.duration_s u_dur, o.duration_s o_dur, a.avg_hr u_hr, o.avg_hr o_hr,
  a.training_load u_load, o.training_load o_load, a.aerobic_te u_te, o.aerobic_te o_te,
  a.vo2max u_vo2, o.vo2max o_vo2, o.vo2max_raw,
  jsonb_array_length(coalesce(a.splits->'lapDTOs','[]'::jsonb)) u_laps, jsonb_array_length(coalesce(o.laps,'[]'::jsonb)) o_laps
from public.garmin_activities a join public.garmin_off_activities o using (activity_id);

-- garmin_daily.bb_wake er en genereret kolonne (raw.stats.bodyBatteryAtWakeTime). Funktionen fletter kun den ene værdi ind i raw.
create or replace function public.set_bb_wake(p_date date, p_val numeric) returns void
language sql security definer set search_path = public as $$
  update public.garmin_daily
     set raw = jsonb_set(coalesce(raw, '{}'::jsonb), '{stats}', coalesce(raw->'stats', '{}'::jsonb) || jsonb_build_object('bodyBatteryAtWakeTime', p_val)),
         updated_at = now()
   where log_date = p_date;
$$;
revoke all on function public.set_bb_wake(date, numeric) from public, anon, authenticated;
grant execute on function public.set_bb_wake(date, numeric) to service_role;

-- Planlagt job (hver halve time kl. 05-21 UTC ≈ 06-22 dansk vintertid):
-- select cron.schedule('sync-garmin-official', '*/30 5-21 * * *', $job$ select net.http_post(url := 'https://<projekt>.supabase.co/functions/v1/sync-garmin-official?days=3&maxFit=10', headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from public.private_config where key='cron_secret')), timeout_milliseconds := 60000); $job$);
