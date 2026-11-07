// Supabase Edge Function: sync-garmin-official
// Henter dine Garmin-data fra den OFFICIELLE Garmin Personal API og skriver dem til de parallelle tabeller
// garmin_off_daily og garmin_off_activities (så de kan sammenlignes med det uofficielle bibliotek).
//
// - Nøglen ligger i private_config (key = garmin_personal_api_key). Den byttes til et 24-timers token ved hver kørsel.
// - Aktiviteter: oversigt fra API'en + original FIT-fil pr. aktivitet (laps, løbeteknik, pulszoner, VO2max).
// - Adgang: kun ejeren (login-token) eller det planlagte job (x-cron-secret), som de øvrige funktioner.
// - Spejling: friske dagstal og NYE aktiviteter skrives også til garmin_daily / garmin_activities (dem dashboardet læser), så
//   data er der kort efter et løb eller en nats søvn. Eksisterende aktiviteter røres ikke (ignore-duplicates); raw/splits/træningsstatus
//   fra det uofficielle bibliotek ændres aldrig.
// Parametre: ?days=3 (1-60) &fit=1 (0 = spring FIT over) &maxFit=6 &mirror=1 (0 = ingen spejling) &debug=1 (kun feltnavne, ingen værdier)
import { Decoder, Stream } from "npm:@garmin/fitsdk@21.221.0";
import { unzipSync } from "npm:fflate@0.8.3";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cron-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const GARMIN = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

// ---------- adgangskontrol (samme mønster som ai-coach) ----------
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function authorized(req: Request, SB_URL: string, SB_KEY: string, cfg: Record<string, string>): Promise<boolean> {
  try {
    const cron = req.headers.get("x-cron-secret") || "";
    if (cron && cfg["cron_secret"] && safeEq(cron, cfg["cron_secret"])) return true;
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!tok || !cfg["owner_uid"]) return false;
    const ur = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: "Bearer " + tok } });
    if (!ur.ok) return false;
    const u = await ur.json();
    return !!u && u.id === cfg["owner_uid"];
  } catch (_) { return false; }
}

// ---------- små hjælpere ----------
// deno-lint-ignore no-explicit-any
type Any = any;
const num = (x: Any): number | null => (x === null || x === undefined || x === "" || isNaN(+x) ? null : +x);
const int = (x: Any): number | null => { const n = num(x); return n === null ? null : Math.round(n); };
const iso = (d: Date) => d.toISOString().substring(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const copenhagenToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
// svarene er enten en liste eller et objekt med en liste (fx {data:[…]} / {hrvSummaries:[…]}) – tag listen
function arr(x: Any): Any[] {
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") { for (const v of Object.values(x)) if (Array.isArray(v)) return v as Any[]; }
  return [];
}
const DATE_KEYS = ["calendarDate", "date", "summaryDate", "startDate", "dailyDate"];
function dateOf(o: Any): string | null {
  if (!o || typeof o !== "object") return null;
  for (const k of DATE_KEYS) { const v = o[k]; if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.substring(0, 10); }
  for (const v of Object.values(o)) if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}
function paths(x: Any, p = "", out: string[] = [], depth = 0): string[] {
  if (out.length > 150 || depth > 5) return out;
  if (Array.isArray(x)) { if (x.length) paths(x[0], p + "[]", out, depth + 1); else out.push(p + "[]"); }
  else if (x && typeof x === "object") { for (const [k, v] of Object.entries(x)) paths(v, p ? p + "." + k : k, out, depth + 1); }
  else out.push(p);
  return out;
}

// ---------- dagsdata ----------
export function mapDaily(src: { daily: Any; sleep: Any; hrv: Any; stress: Any; steps: Any; bb: Any }): Record<string, Any>[] {
  const rows: Record<string, Any> = {};
  const row = (d: string) => (rows[d] ||= { log_date: d, raw: {} });

  for (const it of arr(src.daily)) {
    const d = dateOf(it); if (!d) continue; const r = row(d);
    r.resting_hr = int(it.heartRate?.restingValue);
    r.steps = int(it.movement?.steps?.value);
    r.stress_avg = int(it.stress?.avgLevel); r.stress_max = int(it.stress?.maxLevel);
    r.bb_high = int(it.bodyBattery?.maxValue); r.bb_low = int(it.bodyBattery?.minValue);
    r.bb_charged = int(it.bodyBattery?.chargedValue); r.bb_drained = int(it.bodyBattery?.drainedValue);
    r.kcal_total = num(it.calories?.burnedTotal); r.kcal_active = num(it.calories?.burnedActive); r.kcal_bmr = num(it.calories?.burnedResting);
    r.raw.daily = it;
  }
  for (const it of arr(src.sleep)) {
    const d = dateOf(it); if (!d) continue; const r = row(d);
    r.sleep_secs = int(it.sleepTimeSeconds); r.deep_secs = int(it.deepSleepSeconds); r.light_secs = int(it.lightSleepSeconds);
    r.rem_secs = int(it.remSleepSeconds); r.awake_secs = int(it.awakeSleepSeconds);
    r.sleep_score = int(it.sleepScores?.overall?.value);
    const s0 = num(it.sleepStartTimestampGMT), s1 = num(it.sleepEndTimestampGMT);
    r.sleep_start = s0 ? new Date(s0).toISOString() : null; r.sleep_end = s1 ? new Date(s1).toISOString() : null;
    r.raw.sleep = it;
  }
  for (const it of arr(src.hrv)) {
    const d = dateOf(it); if (!d) continue; const r = row(d);
    r.hrv_last_night = num(it.lastNightAvg); r.hrv_status = it.status ?? null; r.raw.hrv = it;
  }
  for (const it of arr(src.stress)) {
    const d = dateOf(it); if (!d) continue; const r = row(d);
    if (r.stress_avg == null) r.stress_avg = int(it.values?.overallStressLevel);
  }
  for (const it of arr(src.steps)) {
    const d = dateOf(it); if (!d) continue; const r = row(d);
    if (r.steps == null) r.steps = int(it.totalSteps);
  }
  for (const it of arr(src.bb)) {
    const d = dateOf(it); if (!d) continue; const r = row(d);
    if (r.bb_charged == null) r.bb_charged = int(it.charged);
    if (r.bb_drained == null) r.bb_drained = int(it.drained);
    // Body Battery ved opvågning = niveauet ved søvnens slutning
    const desc = arr(it.bodyBatteryValueDescriptorDTOList);
    const li = desc.find((x: Any) => /level/i.test(String(x.bodyBatteryValueDescriptorKey ?? "")))?.bodyBatteryValueDescriptorIndex ?? 2;
    const vals: Any[] = Array.isArray(it.bodyBatteryValuesArray) ? it.bodyBatteryValuesArray : [];
    const end = r.sleep_end ? Date.parse(r.sleep_end) : null;
    if (end && vals.length) {
      // nærmeste måling til søvnens slutning (Garmin måler kun med nogle minutters/en times mellemrum under søvn)
      let best: Any = null, bd = Infinity;
      for (const v of vals) {
        if (!Array.isArray(v) || num(v[0]) === null || num(v[li]) === null) continue;
        const dd = Math.abs(+v[0] - end); if (dd < bd) { bd = dd; best = v; }
      }
      if (best && bd <= 90 * 60000) r.bb_wake = num(best[li]);
    }
  }
  return Object.values(rows).map((r) => ({ ...r, updated_at: new Date().toISOString() }));
}

// ---------- aktiviteter ----------
export function mapActivity(a: Any): Record<string, Any> | null {
  const id = num(a.activityId); if (id === null) return null;
  const local = String(a.startTimeLocal || "").replace(" ", "T").substring(0, 19) || null;
  return {
    activity_id: id, start_local: local, log_date: local ? local.substring(0, 10) : null,
    type: a.activityType?.typeKey ?? null, name: a.activityName ?? null,
    distance_m: num(a.distance), duration_s: num(a.duration), moving_s: num(a.movingDuration),
    avg_hr: num(a.averageHR), max_hr: num(a.maxHR), calories: num(a.calories), avg_speed: num(a.averageSpeed),
    elevation_gain: num(a.elevationGain), training_load: num(a.activityTrainingLoad),
    aerobic_te: num(a.aerobicTrainingEffect), anaerobic_te: num(a.anaerobicTrainingEffect),
    raw: a, updated_at: new Date().toISOString(),
  };
}

// ---------- FIT: laps, løbeteknik, pulszoner, VO2max ----------
const r1 = (x: Any, d = 1) => (num(x) === null ? null : +(+x).toFixed(d));
export function summarizeFit(bytes: Uint8Array): Record<string, Any> {
  const stream = Stream.fromByteArray(Array.from(bytes));
  const dec = new Decoder(stream);
  if (!Decoder.isFIT(stream)) throw new Error("ikke en FIT-fil");
  const { messages, errors } = dec.read({ includeUnknownData: true, mergeHeartRates: false, applyScaleAndOffset: true, expandSubFields: true, expandComponents: true, convertTypesToStrings: true, convertDateTimesToDates: true });
  const laps = (messages.lapMesgs || []).map((l: Any, i: number) => {
    const cad = num(l.avgRunningCadence ?? l.avgCadence);
    const frac = num(l.avgFractionalCadence) ?? 0;
    const dur = num(l.totalTimerTime) ?? num(l.totalElapsedTime);
    return {
      // samme feltnavne som lapDTOs fra det uofficielle bibliotek, så siden kan skifte uden omskrivning
      lapIndex: i + 1,
      startTimeGMT: l.startTime instanceof Date ? l.startTime.toISOString() : null,
      distance: r1(l.totalDistance, 2), duration: r1(dur, 2),
      averageHR: num(l.avgHeartRate), maxHR: num(l.maxHeartRate),
      averageSpeed: r1(l.enhancedAvgSpeed ?? l.avgSpeed, 3),
      averageRunCadence: cad === null ? null : r1((cad + frac) * 2, 1),   // FIT: pr. fod → pr. minut
      strideLength: num(l.avgStepLength) === null ? null : r1(num(l.avgStepLength)! / 10, 1),   // mm → cm
      groundContactTime: r1(l.avgStanceTime, 1),                                                  // ms
      verticalOscillation: num(l.avgVerticalOscillation) === null ? null : r1(num(l.avgVerticalOscillation)! / 10, 2), // mm → cm
      verticalRatio: r1(l.avgVerticalRatio, 2), groundContactBalanceLeft: r1(l.avgStanceTimeBalance, 2),
      elevationGain: num(l.totalAscent), elevationLoss: num(l.totalDescent),
      averageTemperature: num(l.avgTemperature), avgRespirationRate: r1(l.enhancedAvgRespirationRate ?? l.avgRespirationRate, 1),
      wktStepIndex: num(l.wktStepIndex), trigger: l.lapTrigger ?? null,
    };
  });
  const s = (messages.sessionMesgs || [])[0] || {};
  const session = {
    sport: s.sport ?? null, subSport: s.subSport ?? null, numLaps: num(s.numLaps),
    totalTrainingEffect: r1(s.totalTrainingEffect), totalAnaerobicTrainingEffect: r1(s.totalAnaerobicTrainingEffect),
    trainingLoadPeak: r1(s.trainingLoadPeak), workoutFeel: num(s.workoutFeel), workoutRpe: num(s.workoutRpe),
    avgHR: num(s.avgHeartRate), maxHR: num(s.maxHeartRate),
    avgStanceTime: r1(s.avgStanceTime), avgVerticalRatio: r1(s.avgVerticalRatio, 2),
    avgVerticalOscillationCm: num(s.avgVerticalOscillation) === null ? null : r1(num(s.avgVerticalOscillation)! / 10, 2),
    avgStepLengthCm: num(s.avgStepLength) === null ? null : r1(num(s.avgStepLength)! / 10, 1),
    avgRespirationRate: r1(s.enhancedAvgRespirationRate ?? s.avgRespirationRate, 1),
    recordCount: (messages.recordMesgs || []).length, hasRRIntervals: (messages.hrvMesgs || []).length > 0, rrCount: (messages.hrvMesgs || []).length,
  };
  let cs = 0, ct = 0;
  for (const l of laps) if (l.averageRunCadence != null && l.duration) { cs += l.averageRunCadence * l.duration; ct += l.duration; }
  (session as Any).avgCadenceSpm = ct ? r1(cs / ct, 1) : null;   // tidsvægtet gennemsnit af lap-kadencen (pr. minut)
  const tz = (messages.timeInZoneMesgs || []).find((z: Any) => z.referenceMesg === "session") || null;
  const hrZones = tz ? { seconds: tz.timeInHrZone ?? null, boundaries: tz.hrZoneHighBoundary ?? null, maxHR: num(tz.maxHeartRate), restingHR: num(tz.restingHeartRate), thresholdHR: num(tz.thresholdHeartRate) } : null;
  // VO2max ligger i en ukendt (udokumenteret) besked: 140, felt 7 (enhed: 65536/3,5 pr. ml/kg/min). Verificeret mod garmin_raw.max_metrics.
  const raw140 = num((messages["140"] || [])[0]?.["7"]);
  const vo2c = raw140 !== null && raw140 > 0 ? (raw140 * 3.5) / 65536 : null;
  const vo2 = vo2c !== null && vo2c >= 10 && vo2c <= 100 ? r1(vo2c, 1) : null;   // sanity-tjek
  return { laps, session, hr_zones: hrZones, vo2max: vo2, vo2max_raw: raw140, decodeErrors: (errors || []).length };
}

// ---------- hoved ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const SB = Deno.env.get("SUPABASE_URL")!, KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const H = { apikey: KEY, Authorization: "Bearer " + KEY };
  const cr = await fetch(`${SB}/rest/v1/private_config?select=key,value&key=in.(owner_uid,cron_secret,garmin_personal_api_key)`, { headers: H });
  const cfg: Record<string, string> = {}; for (const r of (await cr.json()) as Any[]) cfg[r.key] = r.value;
  if (!(await authorized(req, SB, KEY, cfg))) return json({ ok: false, error: "ikke logget ind" }, 401);
  const gkey = (cfg["garmin_personal_api_key"] || "").trim();
  if (!gkey) return json({ ok: false, error: "no_key", note: "Læg nøglen i private_config (key = garmin_personal_api_key)." });

  const url = new URL(req.url);
  const days = Math.min(60, Math.max(1, +(url.searchParams.get("days") || 3)));
  const doFit = url.searchParams.get("fit") !== "0";
  const maxFit = Math.min(30, Math.max(0, +(url.searchParams.get("maxFit") || 6)));
  const debug = url.searchParams.get("debug") === "1";
  const mirror = url.searchParams.get("mirror") !== "0";
  const t0 = Date.now(), report: Record<string, Any> = { ok: true, days, endpoints: {} };

  // token
  const tr = await fetch(GARMIN + TOKEN_PATH, { method: "POST", headers: { Accept: "*/*", Authorization: "ApiKey " + gkey } });
  if (!tr.ok) {
    const expired = tr.status === 401 || tr.status === 403;
    return json({ ok: false, error: "token", status: tr.status, note: expired ? "Garmin-nøglen er udløbet eller slettet – opret en ny og opdatér garmin_personal_api_key i private_config." : "Garmin svarede ikke som forventet." }, 502);
  }
  const token = (await tr.text()).trim();
  const gget = async (path: string, accept = "application/json") => fetch(GARMIN + path, { headers: { Accept: accept, Authorization: "Bearer " + token } });

  const end = copenhagenToday(), start = addDays(end, -(days - 1));
  const q = (o: Record<string, string | number>) => new URLSearchParams(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]))).toString();
  const eps: Record<string, string> = {
    daily: `/usersummary-service/v2/dailysummaries?${q({ startDate: start, endDate: end })}`,
    sleep: `/sleep-service/sleep/dailySleepSummariesByDate?${q({ startDate: start, endDate: end })}`,
    hrv: `/hrv-service/hrv/daily/${start}/${end}`,
    stress: `/usersummary-service/stats/stress/daily/${start}/${end}`,
    steps: `/usersummary-service/stats/steps/daily/${start}/${end}`,
    bb: `/wellness-service/wellness/bodyBattery/reports/daily?${q({ startDate: start, endDate: end })}`,
    acts: `/activitylist-service/activities/search/activities?${q({ start: 0, limit: 60, startDate: start, endDate: end })}`,
  };
  const data: Record<string, Any> = {};
  await Promise.all(Object.entries(eps).map(async ([k, p]) => {
    try {
      const r = await gget(p); report.endpoints[k] = r.status;
      if (r.ok) data[k] = await r.json();
    } catch (e) { report.endpoints[k] = "fejl: " + String((e as Error).message).slice(0, 80); }
  }));
  if (debug) { report.shapes = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, paths(v)])); return json(report); }

  async function upsert(table: string, pk: string, rows: Record<string, Any>[]) {
    for (let i = 0; i < rows.length; i += 100) {
      const r = await fetch(`${SB}/rest/v1/${table}?on_conflict=${pk}`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.slice(i, i + 100)) });
      if (!r.ok) throw new Error(`${table}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
  }
  try {
    const daily = mapDaily({ daily: data.daily, sleep: data.sleep, hrv: data.hrv, stress: data.stress, steps: data.steps, bb: data.bb });
    await upsert("garmin_off_daily", "log_date", daily);
    report.daily_rows = daily.length;

    const acts = arr(data.acts).map(mapActivity).filter(Boolean) as Record<string, Any>[];
    await upsert("garmin_off_activities", "activity_id", acts);
    report.activity_rows = acts.length;

    // FIT for aktiviteter, der endnu ikke har laps
    report.fit = { done: 0, failed: 0, skipped: 0 };
    if (doFit && acts.length) {
      const ids = acts.map((a) => a.activity_id).join(",");
      const er = await fetch(`${SB}/rest/v1/garmin_off_activities?select=activity_id,has_fit,fit_error&activity_id=in.(${ids})`, { headers: H });
      const have: Any[] = await er.json();
      const todo = have.filter((x) => !x.has_fit && !x.fit_error).map((x) => x.activity_id).slice(0, maxFit);
      report.fit.skipped = have.filter((x) => !x.has_fit).length - todo.length;
      for (const id of todo) {
        if (Date.now() - t0 > 100000) break; // hold tiden
        let patch: Record<string, Any>;
        try {
          const r = await gget(`/download-service/files/activity/${id}`, "application/zip, application/x-zip-compressed, application/octet-stream");
          if (!r.ok) throw new Error("download " + r.status);
          const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
          const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".fit"));
          if (!name) throw new Error("ingen .fit i zip");
          const f = summarizeFit(files[name]);
          patch = { laps: f.laps, session: f.session, hr_zones: f.hr_zones, vo2max: f.vo2max, vo2max_raw: f.vo2max_raw, has_fit: true, fit_error: null, updated_at: new Date().toISOString() };
          report.fit.done++;
        } catch (e) {
          patch = { fit_error: String((e as Error).message).slice(0, 200), updated_at: new Date().toISOString() };
          report.fit.failed++;
        }
        await fetch(`${SB}/rest/v1/garmin_off_activities?activity_id=eq.${id}`, { method: "PATCH", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      }
    }
    // ---------- spejling til de tabeller dashboardet læser ----------
    report.mirror = { daily: 0, activities_new: 0 };
    if (mirror) {
      const DCOLS = ["sleep_start", "sleep_end", "sleep_secs", "deep_secs", "light_secs", "rem_secs", "awake_secs", "sleep_score", "hrv_last_night", "hrv_status", "resting_hr", "steps", "stress_avg", "stress_max", "bb_high", "bb_low", "bb_charged", "bb_drained"];   // bb_wake og kcal_* er genererede kolonner → sættes via set_bb_wake()/set_stats()
      for (const d of daily) {
        // kun værdier vi faktisk har (aldrig null over eksisterende), og én række ad gangen så PostgREST ikke nulstiller kolonner
        const o: Record<string, Any> = { log_date: d.log_date, updated_at: new Date().toISOString() };
        for (const c of DCOLS) if (d[c] !== null && d[c] !== undefined) o[c] = d[c];
        if (Object.keys(o).length <= 2) continue;
        const r = await fetch(`${SB}/rest/v1/garmin_daily?on_conflict=log_date`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([o]) });
        if (!r.ok) throw new Error(`garmin_daily: ${r.status} ${(await r.text()).slice(0, 160)}`);
        report.mirror.daily++;
        if (d.kcal_total != null) {
          const st: Record<string, Any> = { totalKilocalories: d.kcal_total };
          if (d.kcal_active != null) st.activeKilocalories = d.kcal_active;
          if (d.kcal_bmr != null) st.bmrKilocalories = d.kcal_bmr;
          const rk = await fetch(`${SB}/rest/v1/rpc/set_stats`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ p_date: d.log_date, p_stats: st }) });
          if (!rk.ok) throw new Error(`set_stats: ${rk.status} ${(await rk.text()).slice(0, 160)}`);
        }
        if (d.bb_wake !== null && d.bb_wake !== undefined) {
          const rb = await fetch(`${SB}/rest/v1/rpc/set_bb_wake`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ p_date: d.log_date, p_val: d.bb_wake }) });
          if (!rb.ok) throw new Error(`set_bb_wake: ${rb.status} ${(await rb.text()).slice(0, 160)}`);
        }
      }
      if (acts.length) {
        const ids = acts.map((a) => a.activity_id).join(",");
        const rr = await fetch(`${SB}/rest/v1/garmin_off_activities?select=activity_id,start_local,log_date,type,name,distance_m,duration_s,moving_s,avg_hr,max_hr,calories,avg_speed,elevation_gain,training_load,aerobic_te,anaerobic_te,vo2max,laps,session,has_fit,fit_error,raw&activity_id=in.(${ids})`, { headers: H });
        const offs: Any[] = await rr.json();
        const rows = offs.filter((o) => o.has_fit || o.fit_error).map((o) => {
          const raw: Record<string, Any> = { ...(o.raw || {}) };
          const s2 = o.session || {};
          // dynamics i samme felter som det uofficielle biblioteks raw, så siderne kan læse dem uændret
          if (s2.avgStanceTime != null) raw.avgGroundContactTime = s2.avgStanceTime;
          if (s2.avgVerticalOscillationCm != null) raw.avgVerticalOscillation = s2.avgVerticalOscillationCm;
          if (s2.avgVerticalRatio != null) raw.avgVerticalRatio = s2.avgVerticalRatio;
          if (s2.avgStepLengthCm != null) raw.avgStrideLength = s2.avgStepLengthCm;
          if (s2.avgCadenceSpm != null) raw.averageRunningCadenceInStepsPerMinute = s2.avgCadenceSpm;
          if (o.vo2max != null) raw.vO2MaxValue = o.vo2max;
          return {
            activity_id: o.activity_id, start_local: o.start_local, log_date: o.log_date, type: o.type, name: o.name,
            distance_m: o.distance_m, duration_s: o.duration_s, moving_s: o.moving_s, avg_hr: o.avg_hr, max_hr: o.max_hr, calories: o.calories,
            avg_speed: o.avg_speed, elevation_gain: o.elevation_gain, vo2max: o.vo2max, training_load: o.training_load,
            aerobic_te: o.aerobic_te, anaerobic_te: o.anaerobic_te, raw, splits: o.laps && o.laps.length ? { lapDTOs: o.laps, source: "official" } : null,
            updated_at: new Date().toISOString(),
          };
        });
        if (rows.length) {
          // ignore-duplicates: findes aktiviteten allerede (fx fra det uofficielle bibliotek), røres den ikke
          const r = await fetch(`${SB}/rest/v1/garmin_activities?on_conflict=activity_id`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(rows) });
          if (!r.ok) throw new Error(`garmin_activities: ${r.status} ${(await r.text()).slice(0, 160)}`);
          report.mirror.activities_new = (await r.json()).length;
        }
      }
    }
    // statuslinje til dashboardet ("Garmin sidst hentet")
    await upsert("garmin_misc", "kind", [{ kind: "official_sync_status", data: { ok: true, at: new Date().toISOString(), range: [start, end], daily_rows: report.daily_rows, activity_rows: report.activity_rows, fit: report.fit, mirror: report.mirror }, updated_at: new Date().toISOString() }]);
  } catch (e) {
    return json({ ...report, ok: false, error: String((e as Error).message).slice(0, 300) }, 500);
  }
  report.ms = Date.now() - t0;
  return json(report);
});
