/* Sammenhænge på tværs af data ("big picture"-analyse).
   Én motor, to dashboards: run.html viser den på fanen Sammenhænge, livsstil kan genbruge den.
   Henter Garmin-dagsdata, vægt og løb og leder selv efter mønstre – både samme dag og med forsinkelse
   (det du gør i dag, og hvad kroppen gør i morgen). Kun fund der holder statistisk vises;
   resten listes som "tjekket, men intet fundet", så man ikke narres af tilfældigheder. */
(function () {
  "use strict";
  var REST = "https://kphfvznawqcslkubdsyy.supabase.co/rest/v1/";
  var KEY = "sb_publishable_7WZMOKUchp-1zkET6-blSA_cVhrj_Lv";
  var DK = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
  var DK_SHORT = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];

  // ---------- små statistik-hjælpere ----------
  function ok(x) { return x != null && !isNaN(x) && isFinite(x); }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
  function sd(a) { if (a.length < 3) return null; var m = mean(a); return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1)); }
  function pearson(xs, ys) {
    var n = xs.length; if (n < 8) return null;
    var mx = mean(xs), my = mean(ys), sxy = 0, sxx = 0, syy = 0;
    for (var i = 0; i < n; i++) { var dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }
  function slope(xs, ys) {
    var mx = mean(xs), my = mean(ys), sxy = 0, sxx = 0;
    for (var i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
    return sxx ? sxy / sxx : null;
  }
  // er korrelationen større end tilfældigt? (ca. 99 %: |r| > 2,6/√n) og af en vis størrelse
  function strong(r, n, minR) { return r != null && n >= 40 && Math.abs(r) >= Math.max(minR || 0.2, 2.6 / Math.sqrt(n)); }
  // forskel på to grupper: z-score
  function zdiff(a, b) {
    if (a.length < 12 || b.length < 12) return 0;
    var se = Math.sqrt(Math.pow(sd(a), 2) / a.length + Math.pow(sd(b), 2) / b.length);
    return se ? (mean(a) - mean(b)) / se : 0;
  }
  function f1(x) { return (+x).toFixed(1).replace(".", ","); }
  function f0(x) { return String(Math.round(x)); }

  // ---------- data ----------
  function iso(d) { var p = function (n) { return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
  function addDays(s, n) { var a = s.split("-").map(Number); var d = new Date(a[0], a[1] - 1, a[2]); d.setDate(d.getDate() + n); return iso(d); }
  function dow(s) { var a = s.split("-").map(Number); return new Date(a[0], a[1] - 1, a[2]).getDay(); }
  function monday(s) { var d = dow(s); return addDays(s, d === 0 ? -6 : 1 - d); }
  var fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit", hour12: false });
  function bedHour(ts) { // timer efter kl. 18 → fx 23:30 = 23,5; 00:30 = 24,5
    if (!ts) return null;
    var p = fmt.format(new Date(ts)).split(":"), h = +p[0] + (+p[1]) / 60;
    return h < 12 ? h + 24 : h;
  }
  async function get(t, qs) {
    var P = 1000, all = [];
    for (var o = 0; ; o += P) {
      var r = await fetch(REST + t + qs + "&limit=" + P + "&offset=" + o, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
      if (!r.ok) throw new Error(t + " " + r.status);
      var j = await r.json();
      all = all.concat(j);
      if (j.length < P) return all;
    }
  }

  async function load() {
    var res = await Promise.all([
      get("garmin_daily", "?select=log_date,sleep_start,sleep_secs,deep_secs,sleep_score,hrv_last_night,resting_hr,steps,stress_avg,bb_wake&order=log_date.asc"),
      get("weighins", "?select=log_date,weight_kg&order=log_date.asc,moment.asc").catch(function () { return []; }),
      get("garmin_activities", "?select=log_date,distance_m,training_load,type&type=in.(running,treadmill_running)&order=activity_id.asc").catch(function () { return []; })
    ]);
    var days = {};
    res[0].forEach(function (g) {
      days[g.log_date] = {
        date: g.log_date, bed: bedHour(g.sleep_start), sleepH: ok(+g.sleep_secs) && g.sleep_secs ? g.sleep_secs / 3600 : null, deep: g.deep_secs ? g.deep_secs / 60 : null,
        score: ok(+g.sleep_score) && +g.sleep_score > 0 ? +g.sleep_score : null, hrv: +g.hrv_last_night > 0 ? +g.hrv_last_night : null,
        rhr: +g.resting_hr > 0 ? +g.resting_hr : null, steps: +g.steps > 0 ? +g.steps : null, stress: +g.stress_avg > 0 ? +g.stress_avg : null,
        bb: +g.bb_wake > 0 ? +g.bb_wake : null, km: 0, ran: 0, weight: null
      };
    });
    var wsum = {};
    res[1].forEach(function (w) { (wsum[w.log_date] = wsum[w.log_date] || []).push(+w.weight_kg); });
    Object.keys(wsum).forEach(function (k) { if (days[k]) days[k].weight = mean(wsum[k]); else days[k] = { date: k, weight: mean(wsum[k]), km: 0, ran: 0 }; });
    res[2].forEach(function (a) { var d = days[a.log_date]; if (d) { d.km += (+a.distance_m || 0) / 1000; d.ran = 1; } });
    return days;
  }

  // ---------- analyser ----------
  // hver returnerer { id, strength, title, html, chart? } eller { none: "tekst" } hvis ingenting holder
  function bedtime(D) {
    var rows = Object.values(D).filter(function (d) { return ok(d.bed) && ok(d.score) && d.bed < 30; });
    if (rows.length < 60) return null;
    var bs = rows.map(function (d) { return d.bed; }), sc = rows.map(function (d) { return d.score; });
    var r = pearson(bs, sc), b = slope(bs, sc);
    var hv = rows.filter(function (d) { return ok(d.hrv); }), rh = pearson(hv.map(function (d) { return d.bed; }), hv.map(function (d) { return d.hrv; })), bh = slope(hv.map(function (d) { return d.bed; }), hv.map(function (d) { return d.hrv; }));
    if (!strong(r, rows.length)) return { none: "sengetid → søvnscore" };
    var buckets = [["Før 23", function (h) { return h < 23; }], ["23–24", function (h) { return h >= 23 && h < 24; }], ["Efter 24", function (h) { return h >= 24; }]];
    var out = buckets.map(function (bk) { var g = rows.filter(function (d) { return bk[1](d.bed); }); return { label: bk[0], n: g.length, hours: mean(g.filter(function (d) { return ok(d.sleepH); }).map(function (d) { return d.sleepH; })), score: mean(g.map(function (d) { return d.score; })), hrv: mean(g.filter(function (d) { return ok(d.hrv); }).map(function (d) { return d.hrv; })) }; }).filter(function (g) { return g.n >= 12; });
    var first = out[0], last = out[out.length - 1];
    return {
      id: "bed", strength: Math.abs(r), kicker: "Søvn", title: "Sengetid er din største søvn-faktor",
      html: "Jo senere du går i seng, jo dårligere sover du. <b>Hver time senere</b> koster ca. <b class='bad'>" + f1(Math.abs(b)) + " point</b> søvnscore" + (ok(bh) && strong(rh, hv.length, 0.15) ? " og <b class='bad'>" + f1(Math.abs(bh)) + " ms</b> HRV" : "") + ". " +
        (out.length > 1 ? "Før kl. 23: søvnscore <b>" + f0(first.score) + "</b> og <b>" + f1(first.hours) + " t</b> søvn. Efter midnat: <b>" + f0(last.score) + "</b> og <b>" + f1(last.hours) + " t</b>." : "") + " <span class='dim'>(" + rows.length + " nætter)</span>",
      chart: { type: "bar", labels: out.map(function (g) { return g.label; }), data: out.map(function (g) { return +g.score.toFixed(1); }), unit: "søvnscore", color: "rgba(168,85,247,.7)", min: Math.max(0, Math.min.apply(null, out.map(function (g) { return g.score; })) - 8) }
    };
  }

  function stressNext(D) {
    var pairs = [];
    Object.keys(D).forEach(function (k) { var a = D[k], b = D[addDays(k, 1)]; if (a && b && ok(a.stress) && ok(b.score)) pairs.push({ s: a.stress, sc: b.score, bb: b.bb, hrv: b.hrv, bed: b.bed }); });
    if (pairs.length < 60) return null;
    var r = pearson(pairs.map(function (p) { return p.s; }), pairs.map(function (p) { return p.sc; }));
    if (!strong(r, pairs.length)) return { none: "stress → søvn" };
    var sorted = pairs.map(function (p) { return p.s; }).sort(function (a, b) { return a - b; });
    var lo = sorted[Math.floor(sorted.length / 3)], hi = sorted[Math.floor(sorted.length * 2 / 3)];
    var calm = pairs.filter(function (p) { return p.s <= lo; }), mid = pairs.filter(function (p) { return p.s > lo && p.s < hi; }), tense = pairs.filter(function (p) { return p.s >= hi; });
    return {
      id: "stress", strength: Math.abs(r), kicker: "Stress", title: "Stressede dage koster dig næste nats søvn",
      html: "Efter dage med høj stress (over <b>" + f0(hi) + "</b>) får du næste morgen søvnscore <b class='bad'>" + f0(mean(tense.map(function (p) { return p.sc; }))) + "</b> – efter rolige dage (under <b>" + f0(lo) + "</b>): <b class='good'>" + f0(mean(calm.map(function (p) { return p.sc; }))) + "</b>. " + hrvLine(tense, calm, pairs) + " <span class='dim'>(" + pairs.length + " dage)</span>",
      chart: { type: "bar", labels: ["Rolig", "Middel", "Stresset"], data: [calm, mid, tense].map(function (g) { return +mean(g.map(function (p) { return p.sc; })).toFixed(1); }), unit: "næste nats søvnscore", color: "rgba(236,72,153,.7)", min: 50 }
    };
  }

  function hrvLine(tense, calm, all) {
    var a = tense.map(function (p) { return p.hrv; }).filter(ok), b = calm.map(function (p) { return p.hrv; }).filter(ok);
    if (a.length < 20 || b.length < 20) return "";
    var bp = all.filter(function (p) { return ok(p.bed) && p.bed < 30; }), rb = pearson(bp.map(function (p) { return p.s; }), bp.map(function (p) { return p.bed; }));
    return "Det samme gælder HRV: <b class='bad'>" + f0(mean(a)) + " ms</b> mod <b class='good'>" + f0(mean(b)) + " ms</b>." + (rb != null && Math.abs(rb) < 0.2 ? " Det virker uafhængigt af, hvornår du går i seng (stress flytter næsten ikke din sengetid)." : "");
  }

  function weekRhythm(D) {
    var by = [[], [], [], [], [], [], []];
    Object.values(D).forEach(function (d) { if (d.date >= addDays(iso(new Date()), -540)) by[dow(d.date)].push(d); });
    var order = [1, 2, 3, 4, 5, 6, 0];
    function avgOf(f) { return order.map(function (i) { return mean(by[i].map(f).filter(ok)); }); }
    var hrv = avgOf(function (d) { return d.hrv; }), score = avgOf(function (d) { return d.score; });
    if (hrv.some(function (x) { return x == null; })) return null;
    var hi = hrv.indexOf(Math.max.apply(null, hrv)), lo = hrv.indexOf(Math.min.apply(null, hrv));
    // er forskellen reel? sammenlign bedste og værste ugedag
    var z = zdiff(by[order[hi]].map(function (d) { return d.hrv; }).filter(ok), by[order[lo]].map(function (d) { return d.hrv; }).filter(ok));
    if (hrv[hi] - hrv[lo] < 3 || Math.abs(z) < 2.6) return { none: "ugerytme i HRV" };
    var sLo = score.indexOf(Math.min.apply(null, score));
    return {
      id: "week", strength: Math.min(0.6, (hrv[hi] - hrv[lo]) / 10), kicker: "Ugerytme", title: "Din krop har en ugerytme",
      html: "HRV er højest <b>" + DK[order[hi]] + "</b> (" + f0(hrv[hi]) + ") og lavest <b>" + DK[order[lo]] + "</b> (" + f0(hrv[lo]) + "). Din dårligste søvnscore har du i <b>nætten til " + DK[order[sLo]] + "</b> (" + f0(score[sLo]) + ") og din bedste i <b>nætten til " + DK[order[score.indexOf(Math.max.apply(null, score))]] + "</b> (" + f0(Math.max.apply(null, score)) + "). <span class='dim'>(seneste 18 måneder)</span>",
      chart: { type: "bar", labels: order.map(function (i) { return DK_SHORT[i]; }), data: hrv.map(function (x) { return +x.toFixed(1); }), unit: "HRV (ms)", color: "rgba(6,182,212,.7)", min: Math.min.apply(null, hrv) - 4 }
    };
  }

  function runNextDay(D) {
    var ran = [], rest = [];
    Object.keys(D).forEach(function (k) { var a = D[k], b = D[addDays(k, 1)]; if (a && b && a.rhr != null) (a.ran ? ran : rest).push(b); });
    if (ran.length < 25 || rest.length < 25) return null;
    var M = [["HRV", function (d) { return d.hrv; }, 2, "ms"], ["hvilepuls", function (d) { return d.rhr; }, 1, "bpm"], ["dyb søvn", function (d) { return d.deep; }, 5, "min"], ["søvnscore", function (d) { return d.score; }, 2, "point"]];
    var hits = [], miss = [];
    M.forEach(function (m) {
      var a = ran.map(m[1]).filter(ok), b = rest.map(m[1]).filter(ok), z = zdiff(a, b), diff = mean(a) - mean(b);
      (Math.abs(z) >= 2.6 && Math.abs(diff) >= m[2] ? hits : miss).push({ name: m[0], diff: diff, unit: m[3], z: z });
    });
    if (!hits.length) return { none: "løb → søvn og restitution næste dag" };
    return {
      id: "run", strength: Math.min(0.5, Math.abs(hits[0].z) / 10), kicker: "Løb og krop", title: "Hvordan du ser ud dagen efter et løb",
      html: "Dagen efter et løb: " + hits.map(function (h) { return "<b>" + h.name + "</b> <b class='" + (((h.name === "hvilepuls" ? -h.diff : h.diff) > 0) ? "good" : "bad") + "'>" + (h.diff > 0 ? "+" : "−") + f1(Math.abs(h.diff)) + " " + h.unit + "</b>"; }).join(", ") + " sammenlignet med dage efter hviledage. <span class='dim'>Det er en sammenhæng, ikke bevis for årsag – du løber nok mest, når du føler dig frisk.</span> " + (miss.length ? "<span class='dim'>Ingen forskel på " + miss.map(function (m) { return m.name; }).join(" og ") + ".</span>" : "") + " <span class='dim'>(" + ran.length + " løbedage, " + rest.length + " hviledage)</span>"
    };
  }

  function weightWeekday(D) {
    var ws = Object.values(D).filter(function (d) { return ok(d.weight); }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (ws.length < 120) return null;
    var byDate = {}; ws.forEach(function (w) { byDate[w.date] = w.weight; });
    var by = [[], [], [], [], [], [], []];
    ws.forEach(function (w) {
      var nb = []; for (var i = -3; i <= 3; i++) { var v = byDate[addDays(w.date, i)]; if (ok(v)) nb.push(v); }
      if (nb.length >= 4) by[dow(w.date)].push(w.weight - mean(nb));
    });
    var order = [1, 2, 3, 4, 5, 6, 0], avg = order.map(function (i) { return by[i].length >= 25 ? mean(by[i]) : null; });
    if (avg.some(function (x) { return x == null; })) return null;
    var hi = avg.indexOf(Math.max.apply(null, avg)), lo = avg.indexOf(Math.min.apply(null, avg));
    var z = zdiff(by[order[hi]], by[order[lo]]);
    if (avg[hi] - avg[lo] < 0.25 || Math.abs(z) < 2.6) return { none: "vægt over ugen" };
    return {
      id: "wd", strength: Math.min(0.5, (avg[hi] - avg[lo]) / 1.2), kicker: "Vægt", title: "Din vægt svinger med ugedagen",
      html: "Du vejer typisk mest <b>" + DK[order[hi]] + "</b> (<b class='bad'>+" + f1(avg[hi]) + " kg</b> over ugens snit) og mindst <b>" + DK[order[lo]] + "</b> (<b class='good'>" + (avg[lo] < 0 ? "−" : "+") + f1(Math.abs(avg[lo])) + " kg</b>). Så en vejning " + DK[order[hi]] + " siger ikke noget om dit fremskridt. Sammenlign altid samme ugedag. <span class='dim'>(" + ws.length + " vejninger)</span>",
      chart: { type: "bar", labels: order.map(function (i) { return DK_SHORT[i]; }), data: avg.map(function (x) { return +x.toFixed(2); }), unit: "kg fra ugens snit", color: "rgba(245,158,11,.7)", zero: true }
    };
  }

  function weekly(D) {
    // uge-niveau: hvad hænger sammen med at vægten stiger/falder, og med næste uges hvilepuls?
    var W = {};
    Object.values(D).forEach(function (d) { var k = monday(d.date); var w = W[k] || (W[k] = { km: 0, steps: [], stress: [], sleep: [], rhr: [], weight: [], score: [] }); w.km += d.km || 0; [["steps", d.steps], ["stress", d.stress], ["sleep", d.sleepH], ["rhr", d.rhr], ["weight", d.weight], ["score", d.score]].forEach(function (p) { if (ok(p[1])) w[p[0]].push(p[1]); }); });
    var keys = Object.keys(W).sort().filter(function (k) { return W[k].steps.length >= 5; });
    var rows = [];
    keys.forEach(function (k, i) {
      var nk = addDays(k, 7), p = W[addDays(k, -7)], n = W[nk], w = W[k];
      rows.push({ km: w.km, steps: mean(w.steps), stress: mean(w.stress), sleep: mean(w.sleep), score: mean(w.score), rhr: mean(w.rhr), wdelta: p && p.weight.length >= 2 && w.weight.length >= 2 ? mean(w.weight) - mean(p.weight) : null, nrhr: n && n.rhr.length >= 4 ? mean(n.rhr) : null });
    });
    var res = [], none = [];
    function test(name, xf, yf, xn, yn, fmtTxt) {
      var xs = [], ys = []; rows.forEach(function (r) { var x = xf(r), y = yf(r); if (ok(x) && ok(y)) { xs.push(x); ys.push(y); } });
      var r = pearson(xs, ys);
      if (strong(r, xs.length, 0.3)) res.push({ name: name, r: r, n: xs.length, b: slope(xs, ys), text: fmtTxt(slope(xs, ys), r, xs.length) }); else none.push(name);
    }
    test("stress → vægtændring", function (r) { return r.stress; }, function (r) { return r.wdelta; }, "", "", function (b) { return "Uger med mere stress (+10 point) ændrer vægten <b>" + (b > 0 ? "<span class='bad'>+" : "<span class='good'>−") + f1(Math.abs(b * 10)) + " kg</span></b> mod ugen før."; });
    test("søvn → vægtændring", function (r) { return r.sleep; }, function (r) { return r.wdelta; }, "", "", function (b) { return "Uger med <b>1 time mere søvn</b> pr. nat ændrer vægten <b>" + (b > 0 ? "<span class='bad'>+" : "<span class='good'>−") + f1(Math.abs(b)) + " kg</span></b> mod ugen før."; });
    test("skridt → vægtændring", function (r) { return r.steps; }, function (r) { return r.wdelta; }, "", "", function (b) { return "Uger med <b>2.000 skridt mere</b> pr. dag ændrer vægten <b>" + (b > 0 ? "<span class='bad'>+" : "<span class='good'>−") + f1(Math.abs(b * 2000)) + " kg</span></b> mod ugen før."; });
    test("løbekm → vægtændring", function (r) { return r.km; }, function (r) { return r.wdelta; }, "", "", function (b) { return "Uger med <b>10 km mere</b> ændrer vægten <b>" + (b > 0 ? "<span class='bad'>+" : "<span class='good'>−") + f1(Math.abs(b * 10)) + " kg</span></b> mod ugen før."; });
    res.sort(function (a, b) { return Math.abs(b.r) - Math.abs(a.r); });
    var out = [];
    if (res.length) out.push({ id: "weekly", strength: Math.abs(res[0].r), kicker: "Uge for uge", title: "Hvad der hænger sammen på ugebasis", html: res.slice(0, 3).map(function (x) { return x.text + " <span class='dim'>(" + x.n + " uger)</span>"; }).join("<br><br>") });
    none.forEach(function (n) { out.push({ none: n }); });
    return out;
  }

  function monthRunning(D) {
    var ks = Object.keys(D).sort(), xs = [], ys = [];
    ks.forEach(function (k) {
      var km = 0, rs = [], c = 0;
      for (var i = 0; i < 28; i++) { var d = D[addDays(k, -i)]; if (d) { c++; km += d.km || 0; if (ok(d.rhr)) rs.push(d.rhr); } }
      if (c >= 22 && rs.length >= 20) { xs.push(km); ys.push(mean(rs)); }
    });
    if (xs.length < 100) return null;
    var r = pearson(xs, ys), b = slope(xs, ys);
    if (!strong(r, xs.length / 7, 0.25)) return { none: "løb over en måned → hvilepuls" };   // dagene overlapper, så effektiv n er ca. 1/7
    return {
      id: "month", strength: Math.abs(r), kicker: "Stort billede", title: "Mere løb over en måned hænger sammen med lavere hvilepuls",
      html: "Ser man på 4 uger ad gangen, hænger løb og hvilepuls sammen: <b>" + f0(50) + " km mere om måneden</b> (ca. 12 km om ugen) giver en hvilepuls, der er i snit <b class='good'>" + f1(Math.abs(b * 50)) + " bpm lavere</b>. Over en enkelt uge kan man ikke se det. <span class='dim'>(r = " + (+r).toFixed(2).replace(".", ",").replace("-", "−") + ", sammenhæng og ikke bevis for årsag)</span>"
    };
  }

  function longTerm(D) {
    var ks = Object.keys(D).sort(); if (ks.length < 300) return null;
    function seg(f, from, to) { var v = ks.slice(from, to).map(function (k) { return f(D[k]); }).filter(ok); return v.length >= 30 ? mean(v) : null; }
    var N = ks.length, M = [
      ["HRV", function (d) { return d.hrv; }, 3, " ms", 1], ["hvilepuls", function (d) { return d.rhr; }, 1.5, " bpm", -1],
      ["søvnscore", function (d) { return d.score; }, 2.5, "", 1], ["stressniveau", function (d) { return d.stress; }, 3, "", -1],
      ["skridt pr. dag", function (d) { return d.steps; }, 800, "", 1], ["vægt", function (d) { return d.weight; }, 1, " kg", 0]];
    var lines = [];
    M.forEach(function (m) {
      var a = seg(m[1], 0, 90), b = seg(m[1], N - 90, N); if (a == null || b == null) return;
      var diff = b - a; if (Math.abs(diff) < m[2]) return;
      var good = m[4] === 0 ? null : (diff * m[4] > 0);
      lines.push("<b>" + m[0] + "</b>: " + (m[3] === "" && m[0] !== "stressniveau" && m[0] !== "søvnscore" ? f0(a).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " → " + f0(b).replace(/\B(?=(\d{3})+(?!\d))/g, ".") : f1(a) + " → " + f1(b) + m[3]) + " <b class='" + (good == null ? "" : good ? "good" : "bad") + "'>(" + (diff > 0 ? "▲" : "▼") + ")</b>");
    });
    if (!lines.length) return { none: "langsigtet udvikling" };
    var q = {}; ks.forEach(function (k) { var key = k.slice(2, 4) + " K" + (Math.floor((+k.slice(5, 7) - 1) / 3) + 1); (q[key] = q[key] || []).push(D[k]); });
    var qk = Object.keys(q).filter(function (k) { return q[k].length >= 45; });
    var qa = function (f) { return qk.map(function (k) { var v = q[k].map(f).filter(ok); return v.length >= 30 ? +mean(v).toFixed(1) : null; }); };
    return {
      id: "long", strength: 0.35, kicker: "Langsigtet", title: "Dine første og seneste 3 måneder",
      html: lines.join("<br>") + "<br><span class='dim'>Sammenlignet med dine første 90 dage med data (" + ks[0].slice(0, 7) + ").</span>",
      chart: { type: "line", labels: qk, data: qa(function (d) { return d.hrv; }), unit: "HRV (ms)", color: "rgba(6,182,212,.9)", data2: qa(function (d) { return d.rhr; }), unit2: "hvilepuls", color2: "rgba(236,72,153,.9)" }
    };
  }

  async function run() {
    var D = await load();
    var finds = [], none = [];
    [bedtime, stressNext, weekRhythm, runNextDay, weightWeekday, monthRunning, longTerm, weekly].forEach(function (f) {
      var r; try { r = f(D); } catch (e) { r = null; }
      if (!r) return;
      (Array.isArray(r) ? r : [r]).forEach(function (x) { if (x.none) none.push(x.none); else finds.push(x); });
    });
    finds.sort(function (a, b) { return b.strength - a.strength; });
    var n = Object.keys(D).length;
    return { findings: finds, none: none, days: n, from: Object.keys(D).sort()[0] };
  }

  window.Connections = { run: run, _stats: { pearson: pearson, slope: slope, zdiff: zdiff } };
})();
