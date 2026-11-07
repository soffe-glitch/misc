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
    run = next((a for a in acts if (a.get("activityType") or {}).get("typeKey") in ("running", "treadmill_running", "trail_running")), None)
    if acts:
        hunt_json("aktivitetsliste (første 3)", acts[:3])
    if not run:
        print("  (intet løb i perioden – FIT-delen springes over)")
        return
    aid = run["activityId"]
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
