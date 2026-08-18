// Runs on the AWS access portal (awsapps.com/start).
// Expands the configured account (e.g. "dev-admin") and clicks the configured
// permission-set / role (e.g. "PowerUserAccess"), which opens the console.
//
// The portal is a React app with no stable ids, so we match by visible text.
// If a step fails, the console logs the clickable candidates so the text can
// be adjusted in options.

(function () {
  function log(...args) {
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`[${ts}][definity-aws]`, ...args);
  }

  // --- status toast (self-contained; mirrors the Databricks one) -----------

  let statusEl = null;
  let statusHideTimer = null;
  let toastEnabled = true;

  function ensureStatusStyle() {
    if (document.getElementById("dbx-autologin-style")) return;
    const s = document.createElement("style");
    s.id = "dbx-autologin-style";
    s.textContent =
      "@keyframes dbx-spin{to{transform:rotate(360deg)}}" +
      "#dbx-autologin-status{position:fixed;top:16px;right:16px;z-index:2147483647;" +
      "display:flex;align-items:center;gap:9px;padding:10px 14px;border-radius:10px;" +
      "font:13px/1.35 system-ui,-apple-system,sans-serif;color:#fff;" +
      "box-shadow:0 6px 20px rgba(0,0,0,.28);max-width:300px;opacity:1;" +
      "transition:opacity .35s ease}" +
      "#dbx-autologin-status .dbx-spin{width:14px;height:14px;border-radius:50%;" +
      "border:2px solid rgba(255,255,255,.35);border-top-color:#fff;" +
      "animation:dbx-spin .7s linear infinite;flex:none}" +
      "#dbx-autologin-status .dbx-ico{font-size:15px;line-height:1;flex:none}";
    (document.head || document.documentElement).appendChild(s);
  }

  function showStatus(text, state = "waiting") {
    if (!toastEnabled) return;
    ensureStatusStyle();
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.id = "dbx-autologin-status";
      (document.body || document.documentElement).appendChild(statusEl);
    }
    if (statusHideTimer) {
      clearTimeout(statusHideTimer);
      statusHideTimer = null;
    }
    const bg = { waiting: "#1b2733", success: "#137333", error: "#a50e0e" };
    statusEl.style.background = bg[state] || bg.waiting;
    statusEl.style.opacity = "1";
    const icon =
      state === "waiting"
        ? '<span class="dbx-spin"></span>'
        : state === "success"
        ? '<span class="dbx-ico">✓</span>'
        : '<span class="dbx-ico">⚠</span>';
    statusEl.innerHTML = icon + "<span></span>";
    statusEl.lastChild.textContent = text;
    if (state !== "waiting") {
      statusHideTimer = setTimeout(() => {
        if (statusEl) statusEl.style.opacity = "0";
      }, state === "success" ? 3500 : 7000);
    }
  }

  // --- helpers -------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  }

  function waitFor(fn, timeoutMs = 15000, intervalMs = 300) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let val = null;
        try {
          val = fn();
        } catch (e) {
          val = null;
        }
        if (val) return resolve(val);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // Best visible element whose text matches `text`. Prefers an exact match and
  // the deepest (smallest) node, so a click lands on the real control.
  function findByText(text) {
    const target = text.trim().toLowerCase();
    const nodes = document.querySelectorAll(
      "a, button, [role='button'], span, div, h1, h2, h3, h4, li, td, p"
    );
    const matches = [];
    for (const el of nodes) {
      if (!visible(el)) continue;
      // Never match our own status toast (it echoes the account/role names).
      if (el.closest("#dbx-autologin-status")) continue;
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (!t) continue;
      if (t === target) matches.push({ el, exact: true });
      else if (t.includes(target)) matches.push({ el, exact: false });
    }
    if (!matches.length) return null;
    matches.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return (a.el.textContent || "").length - (b.el.textContent || "").length;
    });
    return matches[0].el;
  }

  // All visible elements whose text matches, exact first, smallest first.
  // The portal renders a duplicate (responsive) DOM, so there can be several.
  function findAllByText(text) {
    const target = text.trim().toLowerCase();
    const nodes = document.querySelectorAll(
      "a, button, [role='button'], span, div, h1, h2, h3, h4, li, td, p"
    );
    const matches = [];
    for (const el of nodes) {
      if (!visible(el)) continue;
      if (el.closest("#dbx-autologin-status")) continue;
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (!t) continue;
      if (t === target) matches.push({ el, exact: true });
      else if (t.includes(target)) matches.push({ el, exact: false });
    }
    matches.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return (a.el.textContent || "").length - (b.el.textContent || "").length;
    });
    return matches.map((m) => m.el);
  }

  // Nearest ancestor that is actually a control, so the click hits the toggle.
  function clickableAncestor(el) {
    let n = el;
    while (n && n !== document.body) {
      if (n.matches && n.matches("a, button, [role='button'], [role='row'], tr")) {
        return n;
      }
      n = n.parentElement;
    }
    return el;
  }

  function logCandidates() {
    const nodes = Array.from(
      document.querySelectorAll("a, button, [role='button']")
    ).filter(visible);
    log(
      "clickable candidates:",
      nodes.map((n) => (n.innerText || n.textContent || "").trim()).filter(Boolean)
    );
  }

  // --- flow ----------------------------------------------------------------

  let running = false;

  async function run(cfg) {
    if (running) return;
    running = true;
    const account = cfg.awsAccount || "dev-admin";
    const role = cfg.awsRole || "PowerUserAccess";
    log(`looking for account "${account}", role "${role}"`);
    showStatus(`Opening ${account} / ${role}…`);

    const roleVisible = () => {
      const e = findByText(role);
      if (!e || !visible(e)) return null;
      // findByText may return a wrapper div; resolve to the actual <a> link.
      if (e.tagName === "A") return e;
      const child = e.querySelector("a");
      if (child && visible(child)) return child;
      const parent = e.closest && e.closest("a");
      if (parent && visible(parent)) return parent;
      return e;
    };

    // If the role is already visible (account already expanded), use it.
    let roleEl = roleVisible();
    if (!roleEl) {
      // Wait for the account list to load.
      const first = await waitFor(() => findAllByText(account)[0], 15000);
      if (!first) {
        log("account not found.");
        logCandidates();
        showStatus(`AWS account "${account}" not found`, "error");
        running = false;
        return;
      }

      // There may be several "dev-admin" nodes (duplicate responsive DOM).
      // Try expanding each, clicking a real control, until roles appear.
      const candidates = findAllByText(account);
      log(`found ${candidates.length} "${account}" node(s); trying to expand.`);
      for (const c of candidates) {
        const target = clickableAncestor(c);
        log("clicking account target:", (target.innerText || "").trim().slice(0, 50));
        target.click();
        roleEl = await waitFor(roleVisible, 1500);
        if (roleEl) break;
      }

      if (!roleEl) {
        log("role still not visible after expanding. Candidates after click:");
        logCandidates();
        showStatus(`Role "${role}" not found`, "error");
        running = false;
        return;
      }
    }

    log("clicking role:", (roleEl.innerText || roleEl.textContent || "").trim());
    showStatus(`Opening ${role}…`, "success");
    window.location.href = roleEl.href;
    running = false;
  }

  // --- wiring --------------------------------------------------------------

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "manualStart") loadConfig().then(run);
  });

  loadConfig().then((cfg) => {
    toastEnabled = cfg.showToast !== false;
    if (cfg.awsAutoStart !== false) {
      setTimeout(() => run(cfg), 400);
    }
  });
})();
