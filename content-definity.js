// Chrome-only: runs on the Definity app login page (app|dev.definity.run/login).
// Fills the email and submits. The background script then finds the magic-link
// email in Gmail and navigates this tab to the login link.

(function () {
  function log(...args) {
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`[${ts}][definity-app]`, ...args);
  }

  // --- status toast (self-contained; mirrors the other content scripts) ----

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

  function setNativeValue(el, value) {
    el.focus();
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  }

  function findEmailInput() {
    const sels = [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[autocomplete="username"]',
      'input[autocomplete="email"]'
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (visible(el)) return el;
    }
    return null;
  }

  function buttonLabel(b) {
    return [b.innerText, b.value, b.getAttribute && b.getAttribute("aria-label"), b.title]
      .filter(Boolean)
      .join(" ")
      .trim()
      .toLowerCase();
  }

  function findButton(words) {
    const btns = Array.from(
      document.querySelectorAll('button, input[type="submit"], [role="button"]')
    ).filter(visible);
    log("visible buttons:", btns.map(buttonLabel));
    for (const b of btns) {
      const t = buttonLabel(b);
      if (words.some((w) => t.includes(w))) return b;
    }
    return null;
  }

  function waitFor(fn, timeoutMs = 15000, intervalMs = 300) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const v = fn();
        if (v) return resolve(v);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // --- flow ----------------------------------------------------------------

  let started = false;

  async function run(cfg) {
    if (started) return;
    started = true;

    const email = cfg.definityEmail || cfg.email;
    if (!email) {
      log("no email set in options; set 'Login email' (or a Definity email).");
      started = false;
      return;
    }

    const emailInput = await waitFor(findEmailInput, 10000);
    if (!emailInput) {
      log("email input not found; nothing to do.");
      started = false;
      return;
    }

    log("filling email:", email);
    showStatus("Filling your email…");
    setNativeValue(emailInput, email);

    await new Promise((r) => setTimeout(r, 400));
    const btn = findButton([
      "login",
      "log in",
      "sign in",
      "continue",
      "send",
      "magic",
      "next",
      "email"
    ]);
    if (btn) {
      log("clicking submit:", buttonLabel(btn));
      btn.click();
    } else {
      log("no submit button found; submitting the form.");
      const form = emailInput.closest("form");
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    }

    // Ask background to find the magic link and navigate this tab to it.
    browser.runtime.sendMessage({ type: "startFlow", kind: "definity" });
    log("asked background to watch Gmail for the login link.");
    showStatus("Waiting for the login email…");
    started = false;
  }

  // --- wiring --------------------------------------------------------------

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "flowError") {
      log("flow error:", msg.message);
      showStatus("Auto-login failed: " + msg.message, "error");
    }
    if (msg.type === "manualStart") loadConfig().then(run);
  });

  loadConfig().then((cfg) => {
    toastEnabled = cfg.showToast !== false;
    if (cfg.autoStart) setTimeout(() => run(cfg), 800);
  });
})();
