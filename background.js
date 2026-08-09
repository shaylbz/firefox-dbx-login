// Orchestrates the login flow.
//
// Flow:
//   1. content-databricks.js fills the email, clicks "send code",
//      then sends { type: "startFlow" } to us.
//   2. We open a hidden background Gmail tab at a search URL.
//   3. We inject gmail-extract.js into it. That script scrapes the code
//      and sends { type: "gmailCode", code } back to us.
//   4. We relay the code to the Databricks tab and close the Gmail tab.

let activeFlow = null; // { dbxTabId, gmailTabId, startedAt }

function log(...args) {
  console.log("[dbx-bg]", ...args);
}

// Small colored badge on the toolbar icon: "…" waiting, "✓" done, "!" error.
let badgeClearTimer = null;
function setBadge(text, color, clearAfterMs) {
  browser.browserAction.setBadgeText({ text });
  if (color) browser.browserAction.setBadgeBackgroundColor({ color });
  if (badgeClearTimer) clearTimeout(badgeClearTimer);
  if (clearAfterMs) {
    badgeClearTimer = setTimeout(
      () => browser.browserAction.setBadgeText({ text: "" }),
      clearAfterMs
    );
  }
}

async function startFlow(dbxTabId) {
  if (activeFlow) {
    log("flow already active, ignoring new start");
    return;
  }
  const cfg = await loadConfig();
  activeFlow = { dbxTabId, gmailTabId: null, startedAt: Date.now() };
  log("flow started for dbx tab", dbxTabId);
  setBadge("…", "#d29200");

  const u = encodeURIComponent(cfg.gmailSearchQuery);
  const gmailUrl =
    `https://mail.google.com/mail/u/${cfg.gmailAccountIndex}/#search/${u}`;

  const tab = await browser.tabs.create({ url: gmailUrl, active: false });
  activeFlow.gmailTabId = tab.id;

  if (cfg.hideGmailTab) {
    try {
      await browser.tabs.hide(tab.id);
    } catch (e) {
      log("tabs.hide failed (non-fatal):", e.message);
    }
  }

  // Wait for the tab to finish loading, then inject the scraper.
  await waitForTabComplete(tab.id, 15000);
  try {
    await browser.tabs.executeScript(tab.id, {
      code: `window.__DBX_CFG = ${JSON.stringify(cfg)};`
    });
    await browser.tabs.executeScript(tab.id, { file: "gmail-extract.js" });
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
  const { gmailTabId } = activeFlow;
  activeFlow = null;
  if (gmailTabId != null) {
    try {
      await browser.tabs.remove(gmailTabId);
    } catch (e) {
      log("closing gmail tab failed:", e.message);
    }
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
