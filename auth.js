/* Fælles login til alle dashboards: mail + adgangskode, husker dig "for evigt".
   - Sessionen ligger i localStorage og forny'es automatisk med refresh-token (ingen udløb).
   - Alle kald til databasen (/rest/v1) og funktionerne (/functions/v1) får automatisk din login-token med.
   - Login-formularen er en rigtig formular, så Face ID / nøglering på iPhone kan udfylde den med ét tryk. */
(function () {
  "use strict";
  var SB = "https://kphfvznawqcslkubdsyy.supabase.co";
  var KEY = "sb_publishable_7WZMOKUchp-1zkET6-blSA_cVhrj_Lv";
  var LS = "liv-auth-v1";
  var origFetch = window.fetch.bind(window);

  var session = null;
  try { session = JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) {}
  var loginPromise = null;

  function save(s) {
    session = s;
    try { if (s) localStorage.setItem(LS, JSON.stringify(s)); else localStorage.removeItem(LS); } catch (e) {}
  }
  function fromBody(b) {
    return {
      access_token: b.access_token,
      refresh_token: b.refresh_token,
      expires_at: b.expires_at || Math.floor(Date.now() / 1000) + (b.expires_in || 3600),
      user: b.user || (session && session.user) || null
    };
  }
  function gotrue(path, opts) {
    opts = opts || {};
    var h = { apikey: KEY, "Content-Type": "application/json" };
    if (opts.token) h.Authorization = "Bearer " + opts.token;
    return origFetch(SB + "/auth/v1" + path, { method: opts.method || "POST", headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  }
  function reread() { try { var s = JSON.parse(localStorage.getItem(LS) || "null"); if (s) session = s; } catch (e) {} }
  function fresh(s) { return s && s.expires_at - Math.floor(Date.now() / 1000) > 90; }

  // Forny token (serialiseret på tværs af faner, så refresh-token ikke bruges to gange)
  async function doRefresh() {
    reread();
    if (fresh(session)) return session;               // en anden fane/side nåede det først
    if (!session || !session.refresh_token) return null;
    try {
      var r = await gotrue("/token?grant_type=refresh_token", { body: { refresh_token: session.refresh_token } });
      if (r.ok) { var s = fromBody(await r.json()); save(s); return s; }
      if (r.status === 400 || r.status === 401 || r.status === 403) { save(null); return null; } // refresh-token ugyldig → log ind igen
    } catch (e) { /* offline: behold den gamle session, appen prøver igen senere */ }
    return session;
  }
  function refresh() {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request("liv-auth-refresh", doRefresh);
    return doRefresh();
  }

  async function getToken() {
    if (!session) reread();
    if (session && !fresh(session)) await refresh();
    if (!session) await login();
    return session.access_token;
  }

  // ---------- UI ----------
  var overlay;
  function css() {
    if (document.getElementById("liv-auth-css")) return;
    var st = document.createElement("style"); st.id = "liv-auth-css";
    st.textContent =
      "#liv-auth{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:20px;background:#F5F0E8;color:#1F2B26;font-family:'Hanken Grotesk',system-ui,-apple-system,sans-serif}" +
      "@media(prefers-color-scheme:dark){#liv-auth{background:#0E1411;color:#EEF1EA}}" +
      "#liv-auth .box{width:100%;max-width:360px}" +
      "#liv-auth h1{font-family:'Fraunces',Georgia,serif;font-weight:400;font-size:34px;line-height:1.05;margin:0 0 6px}" +
      "#liv-auth p{margin:0 0 20px;color:#66726B;font-size:14px;line-height:1.5}" +
      "@media(prefers-color-scheme:dark){#liv-auth p{color:#98A89F}}" +
      "#liv-auth label{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#66726B;margin:14px 0 6px}" +
      "#liv-auth input{width:100%;box-sizing:border-box;padding:14px;border-radius:14px;border:1.5px solid #E6DED0;background:#FFFDF9;color:inherit;font:inherit;font-size:16px}" +
      "@media(prefers-color-scheme:dark){#liv-auth input{background:#161D19;border-color:#25302A}}" +
      "#liv-auth input:focus{outline:0;border-color:#2F7A62}" +
      "#liv-auth button{width:100%;margin-top:20px;padding:14px;border:0;border-radius:14px;background:#2F7A62;color:#fff;font:inherit;font-weight:700;font-size:15px;cursor:pointer}" +
      "#liv-auth button:disabled{opacity:.6}" +
      "#liv-auth .err{min-height:20px;margin-top:12px;font-size:13px;color:#C4483B}" +
      "#liv-auth .hint{margin-top:16px;font-size:12px;color:#9AA39C}";
    document.head.appendChild(st);
  }
  function mount(html) {
    css();
    if (!overlay) { overlay = document.createElement("div"); overlay.id = "liv-auth"; (document.body || document.documentElement).appendChild(overlay); }
    overlay.innerHTML = '<div class="box">' + html + "</div>";
    return overlay;
  }
  function unmount() { if (overlay) { overlay.remove(); overlay = null; } }

  function showLogin(done) {
    var o = mount(
      '<h1>Sofies livsstil</h1><p>Log ind for at se dine data. Du bliver husket på denne enhed.</p>' +
      '<form id="liv-login" autocomplete="on">' +
      '<label for="liv-email">Mail</label><input id="liv-email" name="username" type="email" autocomplete="username" inputmode="email" autocapitalize="none" autocorrect="off" required>' +
      '<label for="liv-pw">Adgangskode</label><input id="liv-pw" name="password" type="password" autocomplete="current-password" required>' +
      '<button type="submit">Log ind</button><div class="err" role="alert"></div></form>' +
      '<div class="hint">Tip på iPhone: tryk på adgangskodefeltet og vælg din gemte adgangskode — så logger Face ID dig ind.</div>');
    var f = o.querySelector("form"), err = o.querySelector(".err"), btn = o.querySelector("button");
    f.addEventListener("submit", async function (e) {
      e.preventDefault(); err.textContent = ""; btn.disabled = true; btn.textContent = "Logger ind…";
      try {
        var r = await gotrue("/token?grant_type=password", { body: { email: f.username.value.trim(), password: f.password.value } });
        var b = await r.json();
        if (!r.ok) { err.textContent = r.status === 400 ? "Forkert mail eller adgangskode." : "Kunne ikke logge ind (" + r.status + ")."; btn.disabled = false; btn.textContent = "Log ind"; return; }
        var s = fromBody(b); save(s);
        if (s.user && s.user.user_metadata && s.user.user_metadata.must_change_password) showChange(done); else done();
      } catch (ex) { err.textContent = "Ingen forbindelse. Prøv igen."; btn.disabled = false; btn.textContent = "Log ind"; }
    });
    var em = o.querySelector("#liv-email"); if (em) em.focus();
  }
  function showChange(done) {
    var o = mount(
      '<h1>Vælg din egen adgangskode</h1><p>Du loggede ind med en midlertidig kode. Vælg en ny, som kun du kender (mindst 10 tegn). Din telefon tilbyder at gemme den.</p>' +
      '<form id="liv-change" autocomplete="on"><input type="text" name="username" autocomplete="username" value="' + ((session && session.user && session.user.email) || "") + '" hidden>' +
      '<label for="liv-n1">Ny adgangskode</label><input id="liv-n1" name="password" type="password" autocomplete="new-password" minlength="10" required>' +
      '<label for="liv-n2">Gentag adgangskode</label><input id="liv-n2" type="password" autocomplete="new-password" minlength="10" required>' +
      '<button type="submit">Gem og fortsæt</button><div class="err" role="alert"></div></form>');
    var f = o.querySelector("form"), err = o.querySelector(".err"), btn = o.querySelector("button");
    f.addEventListener("submit", async function (e) {
      e.preventDefault(); err.textContent = "";
      var a = f.querySelector("#liv-n1").value, b2 = f.querySelector("#liv-n2").value;
      if (a !== b2) { err.textContent = "De to adgangskoder er ikke ens."; return; }
      if (a.length < 10) { err.textContent = "Mindst 10 tegn."; return; }
      btn.disabled = true; btn.textContent = "Gemmer…";
      try {
        var r = await gotrue("/user", { method: "PUT", token: session.access_token, body: { password: a, data: { must_change_password: false } } });
        var b = await r.json();
        if (!r.ok) { err.textContent = (b && (b.msg || b.message)) || ("Kunne ikke gemme (" + r.status + ")."); btn.disabled = false; btn.textContent = "Gem og fortsæt"; return; }
        var s = session; s.user = b; save(s); done();
      } catch (ex) { err.textContent = "Ingen forbindelse. Prøv igen."; btn.disabled = false; btn.textContent = "Gem og fortsæt"; }
    });
  }

  function login() {
    if (loginPromise) return loginPromise;
    loginPromise = new Promise(function (resolve) {
      function start() {
        reread();
        // en anden fane kan allerede være logget ind
        if (session && session.access_token && !(session.user && session.user.user_metadata && session.user.user_metadata.must_change_password)) { resolve(); return; }
        var finish = function () { unmount(); resolve(); };
        if (session && session.access_token) showChange(finish); else showLogin(finish);
      }
      if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
    }).then(function () { loginPromise = null; });
    return loginPromise;
  }

  // ---------- patch fetch: tilføj login-token til databasen og funktionerne ----------
  window.fetch = async function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf(SB + "/rest/v1/") === 0 || url.indexOf(SB + "/functions/v1/") === 0) {
      var send = async function () {
        var tok = await getToken();
        var i = Object.assign({}, init || {});
        var h = new Headers(i.headers || (input && input.headers) || {});
        h.set("Authorization", "Bearer " + tok);
        if (!h.has("apikey")) h.set("apikey", KEY);
        i.headers = h;
        return origFetch(input, i);
      };
      var res = await send();
      if (res.status === 401 && session) { // token afvist → forny én gang og prøv igen
        session.expires_at = 0; await refresh(); res = await send();
      }
      return res;
    }
    return origFetch(input, init);
  };

  // log ud på tværs af faner
  window.addEventListener("storage", function (e) { if (e.key === LS && !e.newValue) { session = null; } else if (e.key === LS) { reread(); } });

  // bed browseren om ikke at rydde sessionen
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  window.LivAuth = {
    logout: function () { save(null); location.reload(); },
    user: function () { return session && session.user; },
    ready: function () { return getToken(); }
  };

  // vis login med det samme, hvis der ikke er en session (før siden når at hente data)
  if (!session || !session.refresh_token) { login(); }
})();
