#!/usr/bin/env python3
"""Undersøg de huller, den officielle Garmin Personal API ser ud til at have:
VO2max, træningsstatus og lap-data (splits/løbeteknik) – og find Garmins fulde endpoint-liste.

    export GARMIN_PERSONAL_API_KEY=din-nøgle        (uden anførselstegn)
    pip3 install fitdecode                           (kun til FIT-delen; resten virker uden)
    python3 tools/garmin_api_gaps.py

Rapporten indeholder kun feltnavne og tal for dine egne værdier (VO2max, trin osv.) – ingen
nøgle, token, navn, e-mail eller GPS-positioner.
"""
import io, json, os, re, sys, zipfile
from collections import Counter, OrderedDict
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from garmin_api_compare import get_token, api, http, flatten  # noqa: E402

INTERESTING = re.compile(r"vo2|max_?met|aerobic|anaerobic|training_?effect|recovery|performance|lactate|stamina|readiness|training_?status|load", re.I)
PERSONAL = re.compile(r"name|mail|birth|gender|height|weight|photo|image|url|address|phone|guid|pk$|id$|user_?profile", re.I)
GPS = re.compile(r"position|lat|long|polyline", re.I)


def parse_fit(data):
    """Returnerer [(beskednavn, [(feltnavn, værdi), ...]), ...]. Bruger fitdecode (anbefalet) eller fitparse."""
    try:
        import fitdecode
    except ImportError:
        fitdecode = None
    if fitdecode is not None:
        out = []
        with fitdecode.FitReader(io.BytesIO(data), check_crc=fitdecode.CrcCheck.DISABLED) as fr:
            for fr_ in fr:
                if isinstance(fr_, fitdecode.FitDataMessage):
                    out.append((fr_.name, [(f.name, f.value) for f in fr_.fields]))
        return out
    try:
        import fitparse
    except ImportError:
        raise ImportError("Installer en FIT-læser og kør igen:  pip3 install fitdecode")
    ff = fitparse.FitFile(io.BytesIO(data))
    return [(m.name, [(f.name or f"felt_{f.def_num}", f.value) for f in m.fields]) for m in ff.get_messages()]


def jget(token, path):
    st, body = api(token, path)
    try:
        return st, json.loads(body) if st == 200 and body else None
    except Exception:
        return st, None


def section(t):
    print("\n" + "=" * 8 + " " + t + " " + "=" * 8)


def hunt_json(label, js):
    hits = [(p, v) for p, v in flatten(js) if INTERESTING.search(p)]
    if not hits:
        print(f"  {label}: ingen felter med VO2/træningseffekt/belastning/status i navnet")
        return
    print(f"  {label}: {len(hits)} relevante felter")
    seen = set()
    for p, v in hits:
        if p in seen:
            continue
        seen.add(p)
        print(f"    {p} = {v if not isinstance(v, str) or len(v) < 60 else v[:60] + '…'}")
        if len(seen) >= 25:
            print("    …")
            break


def main():
    key = os.environ.get("GARMIN_PERSONAL_API_KEY", "").strip()
    if not key:
        sys.exit("Sæt GARMIN_PERSONAL_API_KEY først.")
    token = get_token(key)
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=30)

    # ---------- 1) Garmins fulde endpoint-liste ----------
    section("1) ENDPOINT-LISTE FRA GARMIN")
    st, body = http("GET", "https://raw.githubusercontent.com/garmin/connect-personal-api-python/main/README.md", {"Accept": "text/plain"})
    readme = body.decode("utf-8", "replace") if st == 200 else ""
    links = sorted(set(re.findall(r"https?://[^\s)>\]\"']+", readme)))
    spec_links = [l for l in links if re.search(r"swagger|openapi|yaml|\.json|developer\.garmin", l, re.I)]
    print("  Links i README, der kan være spec/dokumentation:")
    for l in spec_links[:12]:
        print("   ", l)
    for l in spec_links:
        if re.search(r"swagger|openapi|\.ya?ml|\.json", l, re.I):
            st2, b2 = http("GET", l, {"Accept": "application/json, text/yaml, */*"})
            txt = b2.decode("utf-8", "replace") if st2 == 200 else ""
            paths = []
            try:
                js = json.loads(txt)
                paths = sorted((js.get("paths") or {}).keys())
            except Exception:
                paths = sorted(set(re.findall(r"^\s{1,4}(/[A-Za-z0-9_\-{}/.]+):", txt, re.M)))
            if paths:
                print(f"\n  Spec fundet: {l}  ({len(paths)} stier)")
                for p in paths:
                    flag = "  <<<" if INTERESTING.search(p) or re.search(r"vo2|training|readiness|status", p, re.I) else ""
                    print("   ", p + flag)
                break
    else:
        print("  (ingen læsbar spec fundet automatisk – åbn Swagger-linket manuelt og send stilisten)")

    # ---------- 2) brugerindstillinger / profil: VO2max? ----------
    section("2) PROFIL-/BRUGERINDSTILLINGER (bruger jeg ikke endnu)")
    st, js = jget(token, "/userprofile-service/userprofile/settings")
    print(f"  HTTP {st}")
    if js is not None:
        pairs = flatten(js)
        keep = [(p, v) for p, v in pairs if not PERSONAL.search(p) and (INTERESTING.search(p) or re.search(r"threshold|ftp|hrzone|maxhr|restinghr|speed", p, re.I))]
        print(f"  {len(pairs)} felter i alt; relevante (VO2max, tærskler, zoner):")
        for p, v in keep[:30]:
            print(f"    {p} = {v}")
        if not keep:
            print("    ingen. Feltnavne (uden personlige):", ", ".join(sorted({p.split('.')[-1] for p, _ in pairs if not PERSONAL.search(p)})[:40]))

    # ---------- 3) aktiviteter: find senest løb + andre typer ----------
    section("3) AKTIVITETER: VO2/TRÆNINGSEFFEKT/STATUS I LISTE OG DETALJE")
    st, acts = jget(token, f"/activitylist-service/activities/search/activities?start=0&limit=40&startDate={start}&endDate={end}")
    if isinstance(acts, dict):
        acts = next((v for v in acts.values() if isinstance(v, list)), [])
    acts = acts or []
    print(f"  {len(acts)} aktiviteter de seneste 30 dage")
    by_type = Counter((a.get("activityType") or {}).get("typeKey", "?") for a in acts)
    print("  typer:", dict(by_type))
    kind = lambda a: (a.get("activityType") or {}).get("typeKey")
    run = (next((a for a in acts if kind(a) in ("running", "trail_running") and (a.get("distance") or 0) >= 3000), None)
           or next((a for a in acts if kind(a) in ("running", "trail_running")), None)
           or next((a for a in acts if kind(a) == "treadmill_running"), None))
    if acts:
        hunt_json("aktivitetsliste (første 3)", acts[:3])
    if not run:
        print("  (intet løb i perioden – FIT-delen springes over)")
        return
    aid = run["activityId"]
    print(f"  valgt løb til FIT-test: type={kind(run)}, {round((run.get('distance') or 0) / 1000, 1)} km")
    st, det = jget(token, f"/activity-service/activity/{aid}")
    if det:
        hunt_json("aktivitetsdetalje (løb)", det)

    # ---------- 4) FIT-filen ----------
    section("4) ORIGINAL FIT-FIL FOR ET LØB: LAPS, LØBETEKNIK, VO2MAX?")
    st, blob = api(token, f"/download-service/files/activity/{aid}", "application/zip, application/x-zip-compressed, application/octet-stream")
    if st != 200:
        print("  download fejlede, HTTP", st)
        return
    try:
        z = zipfile.ZipFile(io.BytesIO(blob))
        name = next(n for n in z.namelist() if n.lower().endswith(".fit"))
        fit_bytes = z.read(name)
    except Exception as e:
        print("  kunne ikke pakke zip ud:", e)
        return
    print(f"  {name}: {len(fit_bytes)} bytes")
    try:
        msgs = parse_fit(fit_bytes)
    except ImportError as e:
        print("  " + str(e))
        return
    except Exception as e:
        print("  kunne ikke læse FIT-filen:", e)
        return
    counts = Counter(n for n, _ in msgs)
    print("  beskedtyper:", dict(counts.most_common()))

    for mtype in ("lap", "session"):
        ms = [f for n, f in msgs if n == mtype]
        if not ms:
            continue
        names = OrderedDict()
        for fields in ms:
            for k, v in fields:
                if v is not None and not GPS.search(str(k)):
                    names.setdefault(k, v)
        print(f"\n  {mtype}: {len(ms)} stk. Felter med værdi (første eksempel):")
        print("   ", "; ".join(f"{k}={v}" for k, v in list(names.items())[:70]))

    # ledetråde i ALLE beskedtyper (VO2max, træningseffekt, status …)
    print("\n  Felter hvis navn tyder på VO2max/effekt/belastning/status, i alle beskedtyper:")
    found = OrderedDict()
    for n, fields in msgs:
        for k, v in fields:
            if v is not None and INTERESTING.search(f"{n}.{k}"):
                found.setdefault(f"{n}.{k}", v)
    for k, v in list(found.items())[:40]:
        print(f"    {k} = {v}")
    if not found:
        print("    ingen")
    unknown = sorted({n for n, _ in msgs if str(n).startswith("unknown")})
    if unknown:
        print("  ukendte beskedtyper (kan skjule fx fysiologiske målinger):", ", ".join(unknown))

    # løbeteknik (jordkontakt, vertikal bevægelse, skridtlængde, effekt) – hvor findes de?
    dyn = re.compile(r"(?<![a-z])stance|vertical|step_length|ground|stride|cycle_length|power|balance", re.I)
    dyn_found = OrderedDict()
    for n, fields in msgs:
        for k, v in fields:
            if v is not None and dyn.search(str(k)):
                dyn_found.setdefault(f"{n}.{k}", v)
    print("\n  Løbeteknik-felter (jordkontakt, vertikal bevægelse, skridtlængde …):")
    for k, v in list(dyn_found.items())[:30]:
        print(f"    {k} = {v}")
    if not dyn_found:
        print("    ingen")

    # split / time_in_zone: kun feltnavne
    for mtype in ("split", "split_summary", "time_in_zone"):
        ms = [f for n, f in msgs if n == mtype]
        if ms:
            print(f"\n  {mtype}: {len(ms)} stk. Felter:", ", ".join(k for k, v in ms[0] if v is not None and not GPS.search(str(k))))

    # ukendte beskedtyper: vis indholdet (kun første besked), og se om en værdi ligner din VO2max
    db_vo2 = None
    st, body = http("GET", "https://kphfvznawqcslkubdsyy.supabase.co/rest/v1/garmin_activities?select=vo2max,aerobic_te,training_load&activity_id=eq." + str(aid),
                    {"apikey": "sb_publishable_7WZMOKUchp-1zkET6-blSA_cVhrj_Lv", "Authorization": "Bearer sb_publishable_7WZMOKUchp-1zkET6-blSA_cVhrj_Lv"})
    try:
        rows = json.loads(body) if st == 200 else []
        db_vo2 = float(rows[0]["vo2max"]) if rows and rows[0].get("vo2max") is not None else None
        print(f"\n  Din database har for dette løb: {rows[0] if rows else '(ikke fundet)'}")
    except Exception:
        pass
    divisors = [1, 2, 3.5, 10, 16, 18.2857, 64, 100, 128, 256, 1000, 1024, 3584, 18724.57, 65536]
    print("\n  Ukendte beskedtyper (første besked; GPS udeladt):")
    seen = Counter(n for n, _ in msgs)
    cand = []
    for n, fields in msgs:
        if not str(n).startswith("unknown") or seen[n] > 50 or n in {x for x, _ in cand}:
            continue
        cand.append((n, fields))
    for n, fields in cand:
        vals = [(k, v) for k, v in fields if v is not None and not GPS.search(str(k))]
        print(f"    {n} ({seen[n]} stk.): " + "; ".join(f"{k}={v}" for k, v in vals[:25]))
        if db_vo2:
            for k, v in vals:
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    for d in divisors:
                        if abs(v / d - db_vo2) < 0.06:
                            print(f"      >>> MULIG VO2MAX: {n}.{k} = {v} (÷ {d} ≈ {db_vo2})")

    rec = [f for n, f in msgs if n == "record"]
    if rec:
        rn = OrderedDict()
        for fields in rec[:50]:
            for k, v in fields:
                if v is not None and not GPS.search(str(k)):
                    rn.setdefault(k, v)
        print(f"\n  record (sekund-for-sekund): {len(rec)} punkter. Felter:", ", ".join(rn.keys()))

    print("\nFærdig. Send rapporten ovenfor tilbage – den indeholder ingen nøgle, token eller GPS.")


if __name__ == "__main__":
    main()
