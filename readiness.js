/* Fælles dagsform-motor for livsstil- og run-dashboardet.
   Én beregning, to visninger: run viser tallet (0-100), livsstil viser frisk/middel/lav + "trækker ned".
   Data: Garmin (via readiness_input-viewet), Garmin-aktiviteter, dagslinjen (daily_log) og sygedage.
   Alt sammenlignes med DINE egne seneste 60 dage, ikke med faste tal. */
(function () {
  "use strict";
  var REST = "https://kphfvznawqcslkubdsyy.supabase.co/rest/v1/";
  var KEY = "sb_publishable_7WZMOKUchp-1zkET6-blSA_cVhrj_Lv";
  var D = { days: {}, acts: {}, logs: {}, sick: new Set(), loaded: false };

  function iso(d) { var p = function (n) { return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
  function add(s, n) { var a = s.split("-").map(Number); var d = new Date(a[0], a[1] - 1, a[2]); d.setDate(d.getDate() + n); return iso(d); }
  function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function num(x) { return x == null || x === "" ? null : +x; }
  function mean(a) { a = a.filter(function (x) { return x != null && !isNaN(x); }); return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
  function sd(a) { a = a.filter(function (x) { return x != null && !isNaN(x); }); if (a.length < 5) return null; var m = mean(a); return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / a.length) || null; }
  function hhmm(h) { var m = Math.round(h * 60); return Math.floor(m / 60) + ":" + (m % 60 < 10 ? "0" : "") + (m % 60); }
  async function get(t, qs) { var r = await fetch(REST + t + qs, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } }); if (!r.ok) throw new Error(t + " " + r.status); return r.json(); }

  async function load(daysBack) {
    var since = add(today(), -(daysBack || 400));
    var res = await Promise.all([
      get("readiness_input", "?select=*&log_date=gte." + since + "&order=log_date.asc"),
      get("garmin_activities", "?select=log_date,training_load,anaerobic_te&log_date=gte." + since).catch(function () { return []; }),
      get("daily_log", "?select=log_date,alcohol_units,day_score,tags&log_date=gte." + since).catch(function () { return []; }),
      get("sick_days", "?select=log_date&log_date=gte." + since).catch(function () { return []; })
    ]);
    D.days = {}; D.acts = {}; D.logs = {}; D.sick = new Set();
    res[0].forEach(function (r) {
      D.days[r.log_date] = { sleep_h: r.sleep_secs == null ? null : r.sleep_secs / 3600, score: num(r.sleep_score), hrv: num(r.hrv), rhr: num(r.rhr),
        stress: num(r.stress) > 0 ? num(r.stress) : null, bb: num(r.bb_wake), acwr: num(r.acwr), acwr_status: r.acwr_status };
    });
    res[1].forEach(function (a) { var x = D.acts[a.log_date] || (D.acts[a.log_date] = { load: 0, anaer: 0 }); x.load += +a.training_load || 0; x.anaer = Math.max(x.anaer, +a.anaerobic_te || 0); });
    res[2].forEach(function (l) { D.logs[l.log_date] = l; });
    res[3].forEach(function (s) { D.sick.add(s.log_date); });
    D.loaded = true;
    return D;
  }

  function baseline(date, key) {
    var v = [];
    for (var i = 1; i <= 60; i++) { var d = D.days[add(date, -i)]; if (d && d[key] != null) v.push(d[key]); }
    return { m: mean(v), s: sd(v), n: v.length };
  }

  // Returnerer { score, level, factors:[{name,val,score,weight,explain}], flags:[...] } eller null
  function computeFor(date) {
    var g = D.days[date];
    if (!g) return null;
    var yday = add(date, -1), gy = D.days[yday] || {}, F = [], flags = [];
    function f(name, val, score, weight, explain) { F.push({ name: name, val: val, score: Math.round(clamp(score, 0, 100)), weight: weight, explain: explain }); }

    // HRV mod dit eget 60-dages snit
    if (g.hrv != null) {
      var bh = baseline(date, "hrv"), z = bh.s ? (g.hrv - bh.m) / bh.s : 0;
      f("HRV", Math.round(g.hrv) + " ms" + (bh.m ? " (snit " + Math.round(bh.m) + ")" : ""), 60 + z * 20, 25,
        z >= 0.8 ? "Klart over dit normale — godt restitueret" : z >= -0.5 ? "Tæt på dit normale" : z >= -1.2 ? "Lidt under dit normale" : "Tydeligt under dit normale — kroppen mangler restitution");
      if (z < -0.8) flags.push("hrv");
    }
    // Hvilepuls mod dit eget snit (lavere = bedre)
    if (g.rhr != null) {
      var br = baseline(date, "rhr"), zr = br.s ? (g.rhr - br.m) / br.s : 0;
      f("Hvilepuls", Math.round(g.rhr) + " bpm", 60 - zr * 20, 15,
        zr <= -0.5 ? "Lavere end normalt — god restitution" : zr < 1 ? "Tæt på dit normale" : "Højere end normalt — mulig stress, træthed eller sygdom på vej");
      if (zr > 1) flags.push("puls");
    }
    // Søvn: Garmins søvnscore + varighed + søvngæld over 4 nætter (fast gulv 6,5 t)
    if (g.score != null || g.sleep_h != null) {
      var ss = g.score != null ? g.score : (g.sleep_h >= 7 ? 85 : g.sleep_h >= 6 ? 40 + (g.sleep_h - 6) * 40 : g.sleep_h * 7);
      var nights = []; for (var k = 0; k < 4; k++) { var dd = D.days[add(date, -k)]; if (dd && dd.sleep_h != null) nights.push(dd.sleep_h); }
      var debt = nights.length >= 3 && mean(nights) < 6.5;
      if (g.sleep_h != null && g.sleep_h < 6) ss = Math.min(ss, 55);
      if (debt) { ss -= 15; flags.push("søvngæld"); }
      if (g.sleep_h != null && g.sleep_h < 6.5) flags.push("søvn");
      if (g.score != null && g.score < 60) flags.push("søvnkvalitet");
      f("Søvn", (g.sleep_h != null ? hhmm(g.sleep_h) + " t" : "") + (g.score != null ? (g.sleep_h != null ? ", " : "") + "score " + g.score : ""), ss, 25,
        debt ? "Søvngæld: under 6,5 t i snit de sidste nætter" : ss >= 80 ? "God søvn" : ss >= 60 ? "OK søvn, ikke optimal" : "Kort eller urolig nat");
    }
    // Body Battery ved opvågning (Garmins eget 0-100)
    if (g.bb != null) {
      var bb = baseline(date, "bb");
      f("Body Battery", Math.round(g.bb) + " ved opvågning", g.bb, 15,
        g.bb >= 80 ? "Fuldt opladet" : g.bb >= 55 ? "Rimeligt opladet" : "Lavt opladet — natten lod dig ikke op");
      if (g.bb < 40 || (bb.m && g.bb < bb.m - 15)) flags.push("batteri");
    }
    // Belastning: Garmins akut/kronisk-ratio + gårsdagens pas
    var ya = D.acts[yday] || { load: 0, anaer: 0 }, hardY = ya.load >= 220 || ya.anaer >= 2.5;
    if (g.acwr != null || ya.load > 0) {
      var ls = g.acwr == null ? 80 : g.acwr < 0.8 ? 90 : g.acwr <= 1.3 ? 90 : g.acwr <= 1.5 ? 60 : 30;
      if (hardY) { ls -= 20; flags.push("ben"); }
      if (g.acwr != null && g.acwr > 1.5) flags.push("belastning");
      f("Belastning", (g.acwr != null ? "ratio " + g.acwr.toFixed(1) : "") + (ya.load ? (g.acwr != null ? " · " : "") + "i går " + Math.round(ya.load) : ""), ls, 10,
        g.acwr != null && g.acwr > 1.5 ? "Belastningen er steget hurtigt — risiko for overbelastning" : hardY ? "Hårdt pas i går — benene kan være trætte" : "Belastningen er i balance");
    }
    // Hverdag: gårsdagens stress, alkohol, dagslinje og sygdom
    var hs = 100, why = [];
    var bs = baseline(date, "stress");
    if (gy.stress != null && bs.m && gy.stress > bs.m + 7) { hs -= 30; flags.push("stress"); why.push("stresset dag i går"); }
    var yl = D.logs[yday] || {};
    if ((+yl.alcohol_units || 0) > 0) { hs -= 30; flags.push("alkohol"); why.push("alkohol i går"); }
    var tags = (yl.tags || []).map(function (x) { return String(x).toLowerCase().replace("\u2212", "-"); });
    if ((yl.day_score != null && +yl.day_score <= 2) || tags.some(function (x) { return ["drænet", "social-", "stresset", "syg", "øv"].indexOf(x) >= 0; })) { hs -= 25; flags.push("drænet"); why.push("drænende dag i går"); }
    var sick = D.sick.has(date) || D.sick.has(yday) || D.sick.has(add(date, -2));
    if (sick) { hs = Math.min(hs, 20); flags.push("syg"); why.push(D.sick.has(date) ? "syg i dag" : "syg for nylig"); }
    f("Hverdag", why.length ? why.join(", ") : "rolig dag i går", hs, 10, why.length ? "Gårsdagen tærer stadig" : "Intet fra i går, der trækker ned");

    var tw = 0, ts = 0; F.forEach(function (x) { tw += x.weight; ts += x.score * x.weight; });
    if (!tw) return null;
    var score = Math.round(ts / tw);
    if (D.sick.has(date)) score = Math.min(score, 40);
    else if (sick) score = Math.min(score, 60);
    var level = score >= 70 ? "frisk" : score >= 50 ? "middel" : "lav";
    return { date: date, score: score, level: level, factors: F, flags: flags };
  }

  window.Readiness = {
    load: load,
    ready: function () { return D.loaded; },
    has: function (date) { return !!D.days[date]; },
    computeFor: computeFor,
    today: function () { return computeFor(today()); },
    FLAG_TXT: { "søvn": "kort nat", "søvnkvalitet": "urolig søvn", "søvngæld": "søvngæld", "hrv": "lav HRV", "puls": "høj hvilepuls",
      "batteri": "lavt Body Battery", "ben": "hård træning i går", "belastning": "høj belastning", "stress": "stresset dag i går",
      "alkohol": "alkohol i går", "drænet": "drænende dag i går", "syg": "syg for nylig" }
  };
})();
