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

// Inject the scraper. MV3 uses scripting.executeScript (multiple files at
// once); MV2 uses tabs.executeScript (one file per call).
async function injectScraper(tabId) {
  if (browser.scripting && browser.scripting.executeScript) {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["config.js", "gmail-extract.js"]
    });
  } else {
    await browser.tabs.executeScript(tabId, { file: "config.js" });
    await browser.tabs.executeScript(tabId, { file: "gmail-extract.js" });
  }
}

async function startFlow(dbxTabId) {
  if (activeFlow) {
    log("flow already active, ignoring new start");
    return;
  }
  const cfg = await loadConfig();
  activeFlow = { dbxTabId, gmailTabId: null, gmailWindowId: null, startedAt: Date.now() };
  log("flow started for dbx tab", dbxTabId);
  setBadge("…", "#d29200");

  const u = encodeURIComponent(cfg.gmailSearchQuery);
  const gmailUrl =
    `https://mail.google.com/mail/u/${cfg.gmailAccountIndex}/#search/${u}`;

  const { tabId, windowId } = await openGmail(gmailUrl, cfg.hideGmailTab);
  activeFlow.gmailTabId = tabId;
  activeFlow.gmailWindowId = windowId;

  // Wait for the tab to finish loading, then inject the scraper.
  await waitForTabComplete(tabId, 15000);
  try {
    await injectScraper(tabId);
    log("injected gmail-extract.js");
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
    startFlow(tabId);
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

  if (msg.type === "gmailError") {
    log("gmail scrape error:", msg.message);
    setBadge("!", "#a50e0e", 6000);
    notifyDbx({ type: "flowError", message: msg.message });
    finishFlow();
    return;
  }
});
