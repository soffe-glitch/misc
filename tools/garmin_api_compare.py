#!/usr/bin/env python3
"""Sammenlign Garmins officielle Personal API med de data, dit uofficielle bibliotek har lagt i Supabase.

Kør lokalt (nøglen må ikke i chat eller i repoet):

    export GARMIN_PERSONAL_API_KEY="din-nøgle"
    python3 tools/garmin_api_compare.py --days 14

Kun Python 3 standardbibliotek. Gemmer rå svar i ./garmin_api_out/ (ligger kun hos dig).
Rapporten på skærmen indeholder kun feltnavne, strukturer og hvilke felter der matcher dine
database-tal – ingen nøgle og ingen token. Den kan du frit sende videre.
"""
import argparse, io, json, os, re, sys, urllib.error, urllib.parse, urllib.request, zipfile
from datetime import date, timedelta

HOST = "https://personal.connectapi.garmin.com"
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
SB = "https://kphfvznawqcslkubdsyy.supabase.co/rest/v1/"
SB_KEY = "sb_publishable_7WZMOKUchp-1zkET6-blSA_cVhrj_Lv"  # samme offentlige nøgle som dashboardet bruger
OUT = "garmin_api_out"


# ---------- HTTP ----------
def http(method, url, headers, timeout=30):
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # netværksfejl
        return 0, str(e).encode()


def get_token(key):
    st, body = http("POST", HOST + TOKEN_PATH, {"Accept": "*/*", "Authorization": "ApiKey " + key})
    if st != 200:
        sys.exit(f"Token-udveksling fejlede: HTTP {st} {body[:200]!r}")
    return body.decode().strip()


def api(token, path, accept="application/json"):
    return http("GET", HOST + path, {"Accept": accept, "Authorization": "Bearer " + token})


def sb(table, qs):
    st, body = http("GET", SB + table + qs, {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY})
    if st != 200:
        print(f"  (Supabase {table}: HTTP {st})")
        return []
    return json.loads(body)


# ---------- flatten / sammenligning ----------
def flatten(x, path="", out=None):
    """Alle bladværdier som (sti, værdi); listeindeks erstattes af []."""
    if out is None:
        out = []
    if isinstance(x, dict):
        for k, v in x.items():
            flatten(v, f"{path}.{k}" if path else k, out)
    elif isinstance(x, list):
        for v in x[:400]:
            flatten(v, path + "[]", out)
    else:
        out.append((path, x))
    return out


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def num_set(pairs):
    d = {}
    for p, v in pairs:
        if is_num(v):
            d.setdefault(p, set()).add(round(float(v), 1))
    return d


def best_match(values, path_values, min_score=0.6, min_vals=3):
    """Find officielle stier, hvis værdisæt dækker mindst min_score af database-værdierne."""
    values = {round(float(v), 1) for v in values if v is not None}
    if len(values) < min_vals:
        return []
    res = []
    for p, s in path_values.items():
        sc = len(values & s) / len(values)
        if sc >= min_score:
            res.append((sc, p))
    return sorted(res, reverse=True)[:3]


KEYWORDS = ["trainingReadiness", "trainingStatus", "vo2", "respiration", "intensityMinutes", "floors", "splits", "lapDTO",
            "verticalOscillation", "groundContact", "cadence", "stride", "temperature", "aerobicTrainingEffect",
            "anaerobicTrainingEffect", "trainingLoad", "sleepStages", "deepSleep", "remSleep", "spo2", "stressLevel",
            "bodyBattery", "hrv", "restingHeartRate", "fitnessAge", "hydration", "weight", "bodyFat", "calories",
            "polyline", "elevation", "power", "performanceCondition", "recoveryTime", "lactate"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    a = ap.parse_args()
    key = os.environ.get("GARMIN_PERSONAL_API_KEY", "").strip()
    if not key:
        sys.exit("Sæt GARMIN_PERSONAL_API_KEY først (export GARMIN_PERSONAL_API_KEY=...).")
    os.makedirs(OUT, exist_ok=True)

    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=a.days - 1)
    s, e = start.isoformat(), end.isoformat()
    print(f"Periode: {s} → {e}  ({a.days} dage)\n")
    token = get_token(key)
    print("Token hentet (gyldigt 24 timer)\n")

    q = lambda **kw: urllib.parse.urlencode(kw)
    endpoints = {
        "daily-summaries": f"/usersummary-service/v2/dailysummaries?{q(startDate=s, endDate=e)}",
        "sleep-summaries": f"/sleep-service/sleep/dailySleepSummariesByDate?{q(startDate=s, endDate=e)}",
        "sleep-last-night": f"/sleep-service/sleep/dailySleep?{q(date=e)}",
        "hrv-summaries": f"/hrv-service/hrv/daily/{s}/{e}",
        "hrv-last-night": f"/hrv-service/hrv/{e}",
        "stress": f"/usersummary-service/stats/stress/daily/{s}/{e}",
        "steps": f"/usersummary-service/stats/steps/daily/{s}/{e}",
        "body-battery": f"/wellness-service/wellness/bodyBattery/reports/daily?{q(startDate=s, endDate=e)}",
        "heart-rate-day": f"/wellness-service/wellness/dailyHeartRate?{q(date=e)}",
        "spo2": f"/wellness-service/wellness/daily/spo2acclimation/{e}",
        "fitness-age": f"/fitnessage-service/fitnessage/v2/{e}",
        "hydration": f"/usersummary-service/stats/hydration/daily/{s}/{e}",
        "weight": f"/weight-service/weight/range/{s}/{e}?includeAll=true",
        "heart-rate-zones": "/biometric-service/heartRateZones/v2",
        "wellness-activity-summaries": f"/wellnessactivity-service/activity/summary/range/{s}/{e}",
        "activities": f"/activitylist-service/activities/search/activities?{q(start=0, limit=50, startDate=s, endDate=e)}",
    }
    data = {}
    print("=== OFFICIELLE ENDPOINTS ===")
    for name, path in endpoints.items():
        st, body = api(token, path)
        ok = st == 200
        try:
            js = json.loads(body) if ok and body else None
        except Exception:
            js = None
        if js is not None:
            data[name] = js
            with open(f"{OUT}/{name}.json", "w") as f:
                json.dump(js, f, ensure_ascii=False, indent=1)
        n = len(flatten(js)) if js is not None else 0
        print(f"  {name:28s} HTTP {st}  {len(body):>8} bytes  {n:>6} felter")

    # aktivitet i detaljer + original-fil
    acts = data.get("activities")
    if isinstance(acts, dict):
        acts = next((v for v in acts.values() if isinstance(v, list)), None)
    first = acts[0] if isinstance(acts, list) and acts else None
    aid = first.get("activityId") if isinstance(first, dict) else None
    if aid:
        for name, path in [("activity-detail", f"/activity-service/activity/{aid}"), ("activity-workouts", f"/activity-service/activity/{aid}/workouts")]:
            st, body = api(token, path)
            try:
                js = json.loads(body) if st == 200 else None
            except Exception:
                js = None
            if js is not None:
                data[name] = js
                with open(f"{OUT}/{name}.json", "w") as f:
                    json.dump(js, f, ensure_ascii=False, indent=1)
            print(f"  {name:28s} HTTP {st}  {len(body):>8} bytes")
        st, body = api(token, f"/download-service/files/activity/{aid}", "application/zip, application/x-zip-compressed, application/octet-stream")
        info = ""
        if st == 200:
            try:
                zf = zipfile.ZipFile(io.BytesIO(body))
                info = "  indhold: " + ", ".join(f"{i.filename} ({i.file_size} B)" for i in zf.infolist())
                open(f"{OUT}/activity-{aid}.zip", "wb").write(body)
            except Exception:
                info = "  (ikke en zip)"
        print(f"  {'activity-download':28s} HTTP {st}  {len(body):>8} bytes{info}")
    else:
        print("  (ingen aktivitet i perioden – spring detalje/download over)")

    # ---------- uofficielle data fra databasen ----------
    print("\n=== UOFFICIELT BIBLIOTEK (Supabase) ===")
    daily = sb("garmin_daily", f"?select=*&log_date=gte.{s}&log_date=lte.{e}&order=log_date.asc")
    dbacts = sb("garmin_activities", f"?select=*&log_date=gte.{s}&log_date=lte.{e}&order=start_local.asc")
    raws = sb("garmin_raw", f"?select=log_date,kind,data&log_date=gte.{s}&log_date=lte.{e}")
    print(f"  garmin_daily: {len(daily)} dage · garmin_activities: {len(dbacts)} · garmin_raw: {len(raws)} rækker")
    kinds = sorted({r["kind"] for r in raws})
    print("  garmin_raw-typer: " + ", ".join(kinds))

    # ---------- sammenlign tal ----------
    official_vals = {}
    for name, js in data.items():
        for p, s_ in num_set(flatten(js)).items():
            official_vals[f"{name}:{p}"] = s_

    print("\n=== DATABASE-FELTER → HVOR FINDES SAMME TAL I DEN OFFICIELLE API? ===")
    daily_metrics = ["sleep_secs", "deep_secs", "light_secs", "rem_secs", "awake_secs", "sleep_score", "hrv_last_night", "resting_hr",
                     "steps", "stress_avg", "stress_max", "bb_high", "bb_low", "bb_charged", "bb_drained", "bb_wake", "vo2max", "training_readiness"]
    matched_official = set()
    for m in daily_metrics:
        vals = [r.get(m) for r in daily if r.get(m) is not None]
        bm = best_match(vals, official_vals)
        matched_official.update(p for _, p in bm)
        print(f"  {m:20s} " + (" | ".join(f"{p} ({sc:.0%})" for sc, p in bm) if bm else ("— ikke fundet" if vals else "(ingen værdier i perioden)")))
    act_metrics = ["distance_m", "duration_s", "moving_s", "avg_hr", "max_hr", "calories", "avg_speed", "elevation_gain", "vo2max",
                   "training_load", "aerobic_te", "anaerobic_te"]
    for m in act_metrics:
        vals = [r.get(m) for r in dbacts if r.get(m) is not None]
        bm = best_match([float(v) for v in vals], {k: v for k, v in official_vals.items() if k.startswith("activit")}, min_vals=2)
        matched_official.update(p for _, p in bm)
        print(f"  akt.{m:16s} " + (" | ".join(f"{p} ({sc:.0%})" for sc, p in bm) if bm else ("— ikke fundet" if vals else "(ingen)")))

    # ---------- nøgleord ----------
    print("\n=== NØGLEORD: FINDES DET HVOR? (O = officiel API, U = uofficielt/database) ===")
    off_paths = " ".join(official_vals.keys()).lower()
    for name, js in data.items():  # også tekst-/null-felter
        off_paths += " " + " ".join(p for p, _ in flatten(js)).lower()
    unoff_paths = ""
    for r in raws:
        unoff_paths += " " + " ".join(p for p, _ in flatten(r.get("data"))[:600]).lower()
    for r in dbacts[:5]:
        unoff_paths += " " + " ".join(p for p, _ in flatten(r.get("raw"))[:800]).lower() + " " + " ".join(p for p, _ in flatten(r.get("splits"))[:800]).lower()
    unoff_paths += " " + " ".join(daily[0].keys()).lower() if daily else ""
    for k in KEYWORDS:
        o, u = k.lower() in off_paths, k.lower() in unoff_paths
        flag = "begge" if o and u else "KUN officiel" if o else "KUN uofficiel" if u else "ingen af dem"
        print(f"  {k:26s} {flag}")

    # ---------- uudnyttede officielle felter ----------
    print("\n=== OFFICIELLE FELTER, SOM IKKE MATCHER NOGET I DATABASEN (talfelter, uddrag) ===")
    unmatched = {}
    for p in official_vals:
        if p not in matched_official:
            unmatched.setdefault(p.split(":")[0], []).append(p.split(":", 1)[1])
    for name, ps in unmatched.items():
        print(f"  {name} ({len(ps)}): " + ", ".join(ps[:25]) + (" …" if len(ps) > 25 else ""))

    print(f"\nRå svar ligger i ./{OUT}/ – send gerne rapporten ovenfor tilbage (den indeholder ingen nøgle/token).")


if __name__ == "__main__":
    main()
