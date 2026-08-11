// Runs on the Databricks login page.
// Step 1: fill the email, click the send/continue button, tell background.
// Step 2: when the code input appears, wait for the code from background,
//         fill it, and submit.

(function () {
  function log(...args) {
    console.log("[definity-databricks]", ...args);
  }

  // --- status toast --------------------------------------------------------

  let statusEl = null;
  let statusHideTimer = null;
  let toastEnabled = true; // set from config on load

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

  // state: "waiting" | "success" | "error"
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
    statusEl.lastChild.textContent = text; // textContent avoids HTML injection
    if (state !== "waiting") {
      statusHideTimer = setTimeout(hideStatus, state === "success" ? 3500 : 7000);
    }
  }

  function hideStatus() {
    if (!statusEl) return;
    statusEl.style.opacity = "0";
    setTimeout(() => {
      if (statusEl) statusEl.remove();
      statusEl = null;
    }, 400);
  }

  // --- helpers -------------------------------------------------------------

  // Set a value the way React/Angular notice (native setter + input event).
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
    const candidates = [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[autocomplete="username"]',
      'input[autocomplete="email"]'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (visible(el)) return el;
    }
    return null;
  }

  // Return the code input box(es). Matches by the `.type` PROPERTY (defaults
  // to "text" even with no type attribute), because Databricks' OTP boxes have
  // no type attribute at all. A segmented OTP returns several boxes; a plain
  // single field returns one.
  function findCodeBoxes() {
    const email = findEmailInput();
    return Array.from(document.querySelectorAll("input"))
      .filter(visible)
      .filter((i) => i !== email)
      .filter((i) => ["text", "tel", "number", "password", ""].includes(i.type));
  }

  // Log every visible input so we can see the code field's real attributes.
  function logVisibleInputs() {
    const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
    log(
      "visible inputs:",
      inputs.map((i) => ({
        type: i.type,
        name: i.name,
        id: i.id,
        autocomplete: i.getAttribute("autocomplete"),
        inputmode: i.getAttribute("inputmode"),
        maxlength: i.getAttribute("maxlength"),
        placeholder: i.placeholder
      }))
    );
  }

  // All the text we can use to identify a button, including icon-button labels.
  function buttonLabel(b) {
    return [
      b.innerText,
      b.value,
      b.getAttribute && b.getAttribute("aria-label"),
      b.title
    ]
      .filter(Boolean)
      .join(" ")
      .trim()
      .toLowerCase();
  }

  // Find a clickable button whose label matches any of the given words.
  function findButton(words) {
    const btns = Array.from(
      document.querySelectorAll('button, input[type="submit"], [role="button"]')
    ).filter(visible);
    // Log every candidate so we can see the real button if matching fails.
    log("visible buttons:", btns.map(buttonLabel));
    for (const b of btns) {
      const txt = buttonLabel(b);
      if (words.some((w) => txt.includes(w))) return b;
    }
    return null;
  }

  // Poll for a condition until it returns truthy or times out.
  function waitFor(fn, timeoutMs = 20000, intervalMs = 300) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const val = fn();
        if (val) return resolve(val);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // --- flow ----------------------------------------------------------------

  let flowRunning = false;

  async function runFlow(cfg) {
    if (flowRunning) return;
    flowRunning = true;

    const email = cfg.email;
    if (!email) {
      log("no email set in options; open the extension options and set one.");
      flowRunning = false;
      return;
    }

    const emailInput = await waitFor(findEmailInput, 10000);
    if (!emailInput) {
      log("email input not found on this page; nothing to do.");
      flowRunning = false;
      return;
    }

    // Start a fresh flow: clear any old code, and mark the flow active so the
    // code-watcher only acts during a real login (not on logged-in pages).
    await browser.storage.local.remove(["pendingCode", "pendingCodeTs"]);
    await browser.storage.local.set({ flowActive: true, flowActiveTs: Date.now() });

    log("filling email:", email);
    showStatus("Filling your email…");
    setNativeValue(emailInput, email);

    // Give the form a moment to enable its button, then click send/continue.
    await new Promise((r) => setTimeout(r, 400));
    const sendBtn = findButton(["send", "continue", "next", "log in", "sign in"]);
    if (sendBtn) {
      log("clicking send button:", (sendBtn.innerText || "").trim());
      sendBtn.click();
    } else {
      log("no send button found; submitting the form directly.");
      const form = emailInput.closest("form");
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    }

    // Ask background to open Gmail and start watching for the code.
    browser.runtime.sendMessage({ type: "startFlow" });
    log("asked background to watch Gmail for the code.");
    showStatus("Waiting for the code email…");

    flowRunning = false;
  }

  // Poll storage.local for a fresh code from the background script.
  // This survives the navigation to the code-entry page.
  async function waitForStoredCode(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { pendingCode, pendingCodeTs } = await browser.storage.local.get([
        "pendingCode",
        "pendingCodeTs"
      ]);
      if (pendingCode && pendingCodeTs && Date.now() - pendingCodeTs < 180000) {
        return pendingCode;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Type a single character into one OTP box, simulating a real keystroke so
  // the OTP component updates its state and advances focus.
  function setBoxValue(box, ch) {
    box.focus();
    box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ch }));
    const proto = Object.getPrototypeOf(box);
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(box, ch);
    else box.value = ch;
    box.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" })
    );
    box.dispatchEvent(new Event("change", { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: ch }));
  }

  let codeHandled = false;

  async function fillAndSubmitCode(code) {
    const boxes = await waitFor(() => {
      const b = findCodeBoxes();
      return b.length ? b : null;
    }, 15000);
    if (!boxes) {
      log("cannot fill code: no code input found.");
      logVisibleInputs();
      return;
    }
    if (codeHandled) return;
    codeHandled = true;
    // Flow is now committed; clear the active flag.
    browser.storage.local.remove(["flowActive", "flowActiveTs"]);

    // Strip the dash etc.; "ABC-DEF" -> ["A","B","C","D","E","F"].
    const chars = code.replace(/[^A-Za-z0-9]/g, "").split("");
    log(`filling "${code}" into ${boxes.length} box(es) as "${chars.join("")}"`);
    showStatus("Code received — entering it…");

    if (boxes.length === 1) {
      setNativeValue(boxes[0], chars.join(""));
    } else {
      for (let i = 0; i < boxes.length && i < chars.length; i++) {
        setBoxValue(boxes[i], chars[i]);
        await sleep(40);
      }
    }

    await sleep(400);
    const submitBtn = findButton([
      "verify", "submit", "continue", "log in", "sign in", "confirm"
    ]);
    if (submitBtn) {
      log("clicking submit:", buttonLabel(submitBtn));
      submitBtn.click();
    } else {
      log("no submit button found; the form may auto-submit when full.");
    }
    showStatus("Logging you in…", "success");
  }

  // Runs on every page load. Waits for the code box(es) to show up, then for
  // the code to arrive in storage, then fills and submits. Decoupled from the
  // email step so it works after the page navigates to code entry.
  async function watchForCode() {
    const boxes = await waitFor(() => {
      const b = findCodeBoxes();
      return b.length ? b : null;
    }, 120000);
    if (!boxes) return; // No code-like inputs here; stay quiet.

    // Only act if a login flow is actually in progress. This keeps the toast
    // and code-filling from triggering on normal, already-logged-in pages.
    const { flowActive, flowActiveTs } = await browser.storage.local.get([
      "flowActive",
      "flowActiveTs"
    ]);
    if (!flowActive || !flowActiveTs || Date.now() - flowActiveTs > 300000) return;

    log(`code input appeared (${boxes.length} box(es)); waiting for the code.`);
    if (!codeHandled) showStatus("Waiting for the code email…");
    const code = await waitForStoredCode(120000);
    if (!code) {
      log("code input is here but no code arrived from Gmail in time.");
      showStatus("No code arrived. Enter it manually.", "error");
      await browser.storage.local.remove(["flowActive", "flowActiveTs"]);
      return;
    }
    await browser.storage.local.remove(["pendingCode", "pendingCodeTs"]);
    fillAndSubmitCode(code);
  }

  // --- wiring --------------------------------------------------------------

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "fillCode") fillAndSubmitCode(msg.code);
    if (msg.type === "flowError") {
      log("flow error:", msg.message);
      showStatus("Auto-login failed: " + msg.message, "error");
    }
    if (msg.type === "manualStart") loadConfig().then(runFlow);
  });

  // Always watch for the code-entry step (handles the post-navigation page).
  watchForCode();

  // Load config: set the toast toggle, then auto-start if enabled.
  loadConfig().then((cfg) => {
    toastEnabled = cfg.showToast !== false;
    if (cfg.autoStart) {
      // Small delay so single-page-app forms have time to render.
      setTimeout(() => runFlow(cfg), 800);
    }
  });
})();
