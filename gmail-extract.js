// Injected by background.js into the hidden Gmail tab (alongside config.js).
// Reads its config via loadConfig() from browser.storage.
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
  let cfg = {};
  let timeoutMs = 60000;
  let codeRe = /\b(\d{6})\b/;

  function log(...args) {
    if (cfg.debug) console.log("[definity-gmail]", ...args);
    // Forward to the background console, which stays open (this tab closes fast).
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

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Click Gmail's "Delete" (move-to-trash) button in the opened email toolbar.
  // Reversible: the email lands in Trash, recoverable for 30 days.
  async function trashOpenedEmail() {
    const buttonLabel = (b) =>
      (
        (b.getAttribute("aria-label") || "") +
        " " +
        (b.getAttribute("data-tooltip") || "")
      ).toLowerCase();

    const findDelete = () => {
      const btns = Array.from(
        document.querySelectorAll('[role="button"], button, div[act]')
      ).filter(isVisible);
      return (
        btns.find((b) => {
          const l = buttonLabel(b);
          return l.includes("delete") || l.includes("trash");
        }) || null
      );
    };

    // 1. Try a directly-visible Delete button in the toolbar.
    let btn = await waitFor(findDelete, 4000);
    if (btn) {
      log("clicking Delete:", buttonLabel(btn).trim());
      btn.click();
      await sleep(700);
      return true;
    }

    // 2. The narrow hidden tab collapses the toolbar, so Delete is inside the
    //    "More email options" overflow menu. Open it, then click Delete.
    const more = Array.from(document.querySelectorAll('[role="button"], button'))
      .filter(isVisible)
      .find((b) => {
        const l = buttonLabel(b);
        return l.includes("more email options") || l.includes("more options");
      });
    if (more) {
      log("opening the more-options menu.");
      more.click();
      await sleep(400);
      const item = await waitFor(() => {
        const items = Array.from(
          document.querySelectorAll('[role="menuitem"], [role="button"], span')
        ).filter(isVisible);
        return (
          items.find((i) => {
            const t = (i.innerText || i.textContent || "").trim().toLowerCase();
            return t === "delete this message" || t === "delete" || t.startsWith("delete");
          }) || null
        );
      }, 3000);
      if (item) {
        log("clicking menu item:", (item.innerText || item.textContent || "").trim());
        item.click();
        await sleep(700);
        return true;
      }
      log("no Delete item found in the more-options menu.");
    }

    // 3. Give up; dump what we saw for diagnosis.
    const labels = Array.from(document.querySelectorAll('[role="button"]'))
      .filter(isVisible)
      .map((b) => b.getAttribute("aria-label") || b.getAttribute("data-tooltip"))
      .filter(Boolean);
    log("no Delete control. visible button labels:", labels.slice(0, 60).join(" | "));
    return false;
  }

  // Delete straight from the search-results row via its hover action button.
  // Works without opening the email, so it avoids the collapsed conversation
  // toolbar. The action buttons live in the row DOM even when not hovered.
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
      const labels = Array.from(
        row.querySelectorAll("[aria-label],[data-tooltip]")
      )
        .map((b) => b.getAttribute("aria-label") || b.getAttribute("data-tooltip"))
        .filter(Boolean);
      log("row action labels:", labels.slice(0, 40).join(" | "));
      return false;
    }
    log(
      "clicking row Delete:",
      btn.getAttribute("aria-label") || btn.getAttribute("data-tooltip")
    );
    btn.click();
    await sleep(600);
    return true;
  }

  async function run() {
    log("scraper started; search =", cfg.gmailSearchQuery);

    // 1. Wait for a matching result row.
    const row = await waitFor(topResultRow, timeoutMs);
    if (!row) {
      return fail("no matching email appeared within the timeout.");
    }

    // 2. Read the code from the subject/snippet — the reliable source.
    const rowText = row.innerText || "";
    log("top row text:", rowText.slice(0, 200));
    let m = rowText.match(codeRe);
    let code = m ? m[1] || m[0] : null;

    // 3. If the subject did not have it, open the email and read the body.
    if (!code) {
      log("no code in the subject; opening the email.");
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
      code = m[1] || m[0];
    }

    // 4. Optionally move the email to Trash. Prefer the list-row Delete; if we
    //    had to open the email above, fall back to the toolbar/overflow.
    if (cfg.trashDbxEmail) {
      let trashed = await trashRow(row);
      if (!trashed) {
        log("row Delete not found; trying the opened-email toolbar.");
        row.click();
        await waitFor(messageBodyText, 8000);
        trashed = await trashOpenedEmail();
      }
      log(trashed ? "email moved to Trash." : "could not delete; left the email.");
    }

    succeed(code);
  }

  (async () => {
    cfg = await loadConfig();
    timeoutMs = cfg.gmailTimeoutMs || 60000;
    codeRe = new RegExp(cfg.codeRegex || "\\b(\\d{6})\\b");
    run();
  })();
})();
