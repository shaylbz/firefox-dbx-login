// Injected by background.js into the Gmail tab (alongside config.js) for the
// Definity magic-link flow. Finds the newest matching email, opens it, and
// pulls out the login link, then sends { type: "gmailLink", url } back.
//
// Uses the same fragile Gmail selectors as gmail-extract.js (.zA row, .a3s
// body). Logs are forwarded to the background console.

(function () {
  let cfg = {};
  let timeoutMs = 60000;

  function log(...args) {
    if (cfg.debug) console.log("[definity-gmail-link]", ...args);
    try {
      browser.runtime.sendMessage({
        type: "gmailLog",
        text: args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" ")
      });
    } catch (e) {}
  }

  function fail(message) {
    log("FAIL:", message);
    browser.runtime.sendMessage({ type: "gmailError", message });
  }

  function succeed(url) {
    log("link found:", url);
    browser.runtime.sendMessage({ type: "gmailLink", url });
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
    const rows = document.querySelectorAll("tr.zA, div[role='main'] tr.zA");
    return rows.length ? rows[0] : null;
  }

  function messageBody() {
    const bodies = document.querySelectorAll("div.a3s");
    return bodies.length ? bodies[bodies.length - 1] : null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Move a search-result row to Trash via its hover Delete action (reversible).
  async function trashRow(row) {
    ["mouseover", "mouseenter", "mousemove"].forEach((type) =>
      row.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    );
    await sleep(200);
    const findInRow = () => {
      const btns = Array.from(
        row.querySelectorAll('[role="button"], [aria-label], [data-tooltip]')
      );
      return (
        btns.find((b) => {
          const l = (
            (b.getAttribute("aria-label") || "") +
            " " +
            (b.getAttribute("data-tooltip") || "")
          ).toLowerCase();
          return l.includes("delete") || l.includes("trash");
        }) || null
      );
    };
    const btn = await waitFor(findInRow, 2000);
    if (!btn) {
      const labels = Array.from(row.querySelectorAll("[aria-label],[data-tooltip]"))
        .map((b) => b.getAttribute("aria-label") || b.getAttribute("data-tooltip"))
        .filter(Boolean);
      log("row action labels:", labels.slice(0, 40).join(" | "));
      return false;
    }
    log("clicking row Delete:", btn.getAttribute("aria-label") || btn.getAttribute("data-tooltip"));
    btn.click();
    await sleep(600);
    return true;
  }

  // After reading the link we are in the conversation view (no row Delete).
  // Re-open the results list via the search hash, then delete the top row.
  async function trashAfterRead() {
    location.hash = "#search/" + encodeURIComponent(cfg.definitySearchQuery);
    const row = await waitFor(topResultRow, 6000);
    if (!row) {
      log("could not return to the results list to delete.");
      return false;
    }
    return trashRow(row);
  }

  // Gmail rewrites external links to https://www.google.com/url?q=<real>.
  // Return the real target so navigation skips Google's redirect.
  function unwrap(href) {
    try {
      const u = new URL(href);
      if (u.hostname.endsWith("google.com") && u.pathname === "/url") {
        return u.searchParams.get("q") || u.searchParams.get("url") || href;
      }
    } catch (e) {}
    return href;
  }

  // Pick the login link from the message body.
  function findLoginHref(body) {
    const anchors = Array.from(body.querySelectorAll("a[href]"));
    if (!anchors.length) return null;
    // 1) an anchor whose visible text mentions "login".
    let a = anchors.find((x) =>
      (x.innerText || x.textContent || "").trim().toLowerCase().includes("login")
    );
    // 2) an anchor whose (possibly wrapped) href points at the app/token.
    if (!a) {
      a = anchors.find((x) => {
        const h = unwrap(x.href);
        return /definity\.run\/token|definity\.run|awstrack\.me|magic/i.test(h);
      });
    }
    return a ? unwrap(a.href) : null;
  }

  async function run() {
    log("link scraper started; search =", cfg.definitySearchQuery);

    const row = await waitFor(topResultRow, timeoutMs);
    if (!row) return fail("no matching email appeared within the timeout.");

    log("opening the email.");
    row.click();
    const body = await waitFor(messageBody, 15000);
    if (!body) {
      return fail("message opened but body not found (check .a3s selector).");
    }

    const url = findLoginHref(body);
    if (!url) {
      log("body text was:", (body.innerText || "").slice(0, 300));
      return fail("no login link found in the email body.");
    }

    // Optionally move the login email to Trash (reversible).
    if (cfg.trashDbxEmail) {
      const trashed = await trashAfterRead();
      log(trashed ? "email moved to Trash." : "could not delete; left the email.");
    }

    succeed(url);
  }

  (async () => {
    cfg = await loadConfig();
    timeoutMs = cfg.gmailTimeoutMs || 60000;
    run();
  })();
})();
