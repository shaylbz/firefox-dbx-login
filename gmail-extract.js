// Injected by background.js into the hidden Gmail tab.
// Config is passed in as window.__DBX_CFG.
//
// Strategy:
//   1. Wait for the search result rows to render.
//   2. Open the newest (top) result.
//   3. Read the message body text and pull the code out with a regex.
//   4. Send { type: "gmailCode", code } back to the background script.
//
// The Gmail class names below (.zA row, .a3s body) are the fragile part.
// They have been stable for years but can change. Debug logs show what
// was found so you can adjust the selectors if needed.

(function () {
  const cfg = window.__DBX_CFG || {};
  const timeoutMs = cfg.gmailTimeoutMs || 60000;
  const codeRe = new RegExp(cfg.codeRegex || "\\b(\\d{6})\\b");

  function log(...args) {
    if (cfg.debug) console.log("[dbx-gmail]", ...args);
  }

  function fail(message) {
    log("FAIL:", message);
    browser.runtime.sendMessage({ type: "gmailError", message });
  }

  function succeed(code) {
    log("code found:", code);
    browser.runtime.sendMessage({ type: "gmailCode", code });
  }

  function waitFor(fn, ms, interval = 500) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let val;
        try {
          val = fn();
        } catch (e) {
          val = null;
        }
        if (val) return resolve(val);
        if (Date.now() - start > ms) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function topResultRow() {
    // .zA is a Gmail conversation row. First one is the newest match.
    const rows = document.querySelectorAll("tr.zA, div[role='main'] tr.zA");
    return rows.length ? rows[0] : null;
  }

  function messageBodyText() {
    // .a3s is the classic Gmail message body container.
    const bodies = document.querySelectorAll("div.a3s");
    if (!bodies.length) return null;
    // Use the last (most recent) body in the thread.
    return bodies[bodies.length - 1].innerText || "";
  }

  async function run() {
    log("scraper started; search =", cfg.gmailSearchQuery);

    // 1. Wait for a matching result row.
    const row = await waitFor(topResultRow, timeoutMs);
    if (!row) {
      return fail("no matching email appeared within the timeout.");
    }

    // 2. Try the subject + snippet text first. The Databricks code is in the
    //    subject, so we often do not need to open the email at all.
    const rowText = row.innerText || "";
    log("top row text:", rowText.slice(0, 200));
    let m = rowText.match(codeRe);
    if (m) return succeed(m[1] || m[0]);

    // 3. Fall back to opening the email and reading the body.
    log("no code in the row text; opening the email.");
    row.click();
    const bodyText = await waitFor(messageBodyText, 15000);
    if (!bodyText) {
      return fail("message opened but body text not found (check .a3s selector).");
    }
    m = bodyText.match(codeRe);
    if (!m) {
      log("body text was:", bodyText.slice(0, 300));
      return fail("no code matched the regex in the email body.");
    }
    succeed(m[1] || m[0]);
  }

  run();
})();
