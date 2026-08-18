// Orchestrates the login flow.
//
// Flow:
//   1. content-databricks.js fills the email, clicks "send code",
//      then sends { type: "startFlow" } to us.
//   2. We open a hidden background Gmail tab at a search URL.
//   3. We inject gmail-extract.js into it. That script scrapes the code
//      and sends { type: "gmailCode", code } back to us.
//   4. We relay the code to the Databricks tab and close the Gmail tab.

let activeFlow = null; // { dbxTabId, gmailTabId, gmailWindowId, startedAt }

function log(...args) {
  console.log("[definity-bg]", ...args);
}

// MV3 (Chrome) uses browser.action; MV2 (Firefox) uses browser.browserAction.
const badgeAction = browser.action || browser.browserAction;

// Small colored badge on the toolbar icon: "…" waiting, "✓" done, "!" error.
let badgeClearTimer = null;
function setBadge(text, color, clearAfterMs) {
  if (!badgeAction) return;
  badgeAction.setBadgeText({ text });
  if (color) badgeAction.setBadgeBackgroundColor({ color });
  if (badgeClearTimer) clearTimeout(badgeClearTimer);
  if (clearAfterMs) {
    badgeClearTimer = setTimeout(
      () => badgeAction.setBadgeText({ text: "" }),
      clearAfterMs
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Show/update an on-page status toast in a tab by injecting a self-contained
// renderer. Driven from the background so it survives page reloads and the
// final navigation (used for the Definity magic-link flow).
async function injectToast(tabId, text, state) {
  if (tabId == null) return;
  const render = (text, state) => {
    const id = "dbx-autologin-status";
    if (!document.getElementById("dbx-autologin-style")) {
      const s = document.createElement("style");
      s.id = "dbx-autologin-style";
      s.textContent =
        "@keyframes dbx-spin{to{transform:rotate(360deg)}}" +
        "#dbx-autologin-status{position:fixed;top:16px;right:16px;z-index:2147483647;" +
        "display:flex;align-items:center;gap:9px;padding:10px 14px;border-radius:10px;" +
        "font:13px/1.35 system-ui,-apple-system,sans-serif;color:#fff;" +
        "box-shadow:0 6px 20px rgba(0,0,0,.28);max-width:300px;transition:opacity .35s ease}" +
        "#dbx-autologin-status .dbx-spin{width:14px;height:14px;border-radius:50%;" +
        "border:2px solid rgba(255,255,255,.35);border-top-color:#fff;" +
        "animation:dbx-spin .7s linear infinite;flex:none}" +
        "#dbx-autologin-status .dbx-ico{font-size:15px;line-height:1;flex:none}";
      (document.head || document.documentElement).appendChild(s);
    }
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      (document.body || document.documentElement).appendChild(el);
    }
    const bg = { waiting: "#1b2733", success: "#137333", error: "#a50e0e" };
    el.style.background = bg[state] || bg.waiting;
    el.style.opacity = "1";
    const icon =
      state === "waiting"
        ? '<span class="dbx-spin"></span>'
        : state === "success"
        ? '<span class="dbx-ico">✓</span>'
        : '<span class="dbx-ico">⚠</span>';
    el.innerHTML = icon + "<span></span>";
    el.lastChild.textContent = text;
    if (state !== "waiting") {
      setTimeout(() => {
        if (el) el.style.opacity = "0";
      }, state === "success" ? 3500 : 7000);
    }
  };
  try {
    if (browser.scripting && browser.scripting.executeScript) {
      await browser.scripting.executeScript({
        target: { tabId },
        func: render,
        args: [text, state]
      });
    } else {
      await browser.tabs.executeScript(tabId, {
        code: `(${render.toString()})(${JSON.stringify(text)},${JSON.stringify(state)})`
      });
    }
  } catch (e) {
    log("toast inject failed:", e.message);
  }
}

// Open the Gmail page as invisibly as each browser allows.
// Firefox: an inactive tab hidden with tabs.hide().
// Chrome (no tabs.hide): a minimized, unfocused popup window.
async function openGmail(gmailUrl, hide) {
  if (browser.tabs.hide) {
    const tab = await browser.tabs.create({ url: gmailUrl, active: false });
    if (hide) {
      try {
        await browser.tabs.hide(tab.id);
      } catch (e) {
        log("tabs.hide failed (non-fatal):", e.message);
      }
    }
    return { tabId: tab.id, windowId: null };
  }
  if (hide && browser.windows && browser.windows.create) {
    const win = await browser.windows.create({
      url: gmailUrl,
      state: "minimized",
      focused: false,
      type: "popup"
    });
    const tabId =
      win.tabs && win.tabs[0]
        ? win.tabs[0].id
        : (await browser.tabs.query({ windowId: win.id }))[0].id;
    return { tabId, windowId: win.id };
  }
  const tab = await browser.tabs.create({ url: gmailUrl, active: false });
  return { tabId: tab.id, windowId: null };
}

// Inject a scraper. MV3 uses scripting.executeScript (multiple files at once);
// MV2 uses tabs.executeScript (one file per call).
async function injectScraper(tabId, files) {
  // Firefox MV2 has tabs.executeScript; Chrome MV3 removed it and uses scripting.
  if (browser.tabs && browser.tabs.executeScript) {
    for (const file of files) {
      await browser.tabs.executeScript(tabId, { file });
    }
  } else {
    await browser.scripting.executeScript({ target: { tabId }, files });
  }
}

async function startFlow(dbxTabId, kind) {
  if (activeFlow) {
    log("flow already active, ignoring new start");
    return;
  }
  kind = kind || "databricks";
  const cfg = await loadConfig();
  activeFlow = {
    dbxTabId,
    kind,
    showToast: cfg.showToast !== false,
    gmailTabId: null,
    gmailWindowId: null,
    startedAt: Date.now()
  };
  log(`flow started (${kind}) for tab`, dbxTabId);
  setBadge("…", "#d29200");

  // Record when this login started so the scraper can reject an older email.
  await browser.storage.local.set({ flowStartTs: activeFlow.startedAt });

  // The Definity login tab may reload on submit and is navigated away at the
  // end, so drive its "waiting" toast from here (survives reloads).
  if (kind === "definity" && activeFlow.showToast) {
    injectToast(dbxTabId, "Waiting for the login email…", "waiting");
  }

  // Per-flow Gmail search + scraper. "definity" extracts a magic link;
  // "databricks" extracts the verification code.
  const searchQuery =
    kind === "definity" ? cfg.definitySearchQuery : cfg.gmailSearchQuery;
  const scraper =
    kind === "definity" ? "gmail-link-extract.js" : "gmail-extract.js";

  const u = encodeURIComponent(searchQuery);
  const gmailUrl =
    `https://mail.google.com/mail/u/${cfg.gmailAccountIndex}/#search/${u}`;

  const { tabId, windowId } = await openGmail(gmailUrl, cfg.hideGmailTab);
  activeFlow.gmailTabId = tabId;
  activeFlow.gmailWindowId = windowId;

  // Wait for the tab to finish loading, then inject the scraper.
  await waitForTabComplete(tabId, 15000);
  try {
    await injectScraper(tabId, [scraper]);
    log("injected", scraper);
  } catch (e) {
    log("injection failed:", e.message);
    await finishFlow();
    notifyDbx({ type: "flowError", message: "Gmail injection failed: " + e.message });
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") finish();
    };
    browser.tabs.onUpdated.addListener(listener);
    // Also check current state in case it is already complete.
    browser.tabs.get(tabId).then((t) => {
      if (t.status === "complete") finish();
    });
    setTimeout(finish, timeoutMs);
  });
}

async function finishFlow() {
  if (!activeFlow) return;
  const { gmailTabId, gmailWindowId } = activeFlow;
  activeFlow = null;
  try {
    if (gmailWindowId != null) {
      await browser.windows.remove(gmailWindowId);
    } else if (gmailTabId != null) {
      await browser.tabs.remove(gmailTabId);
    }
  } catch (e) {
    log("closing gmail tab/window failed:", e.message);
  }
}

function notifyDbx(msg) {
  if (!activeFlow) return;
  browser.tabs.sendMessage(activeFlow.dbxTabId, msg).catch((e) => {
    log("could not message dbx tab:", e.message);
  });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  if (msg.type === "startFlow") {
    const tabId = sender.tab ? sender.tab.id : msg.dbxTabId;
    startFlow(tabId, msg.kind);
    return;
  }

  if (msg.type === "gmailLog") {
    console.log("[definity-gmail]", msg.text);
    return;
  }

  if (msg.type === "gmailCode") {
    log("received code from gmail:", msg.code);
    setBadge("✓", "#137333", 4000);
    // Store it so the code-entry page picks it up even after a navigation.
    browser.storage.local.set({ pendingCode: msg.code, pendingCodeTs: Date.now() });
    notifyDbx({ type: "fillCode", code: msg.code });
    finishFlow();
    return;
  }

  if (msg.type === "gmailLink") {
    log("received magic link from gmail:", msg.url);
    setBadge("✓", "#137333", 4000);
    const tabId = activeFlow ? activeFlow.dbxTabId : null;
    const showToast = activeFlow ? activeFlow.showToast : false;
    finishFlow();
    (async () => {
      if (tabId == null) return;
      if (showToast) {
        // Show a success toast briefly before we navigate the tab away.
        await injectToast(tabId, "Login link received — signing you in…", "success");
        await sleep(900);
      }
      try {
        await browser.tabs.update(tabId, { url: msg.url });
      } catch (e) {
        log("navigating to magic link failed:", e.message);
      }
    })();
    return;
  }

  if (msg.type === "gmailError") {
    log("gmail scrape error:", msg.message);
    setBadge("!", "#a50e0e", 6000);
    notifyDbx({ type: "flowError", message: msg.message });
    finishFlow();
    return;
  }
});
