# CLAUDE.md

Guidance for AI agents working in this repository.

## What this is

A personal browser extension that auto-logs the developer into several
internal tools and performs a few one-click actions. It runs on **both Firefox
and Chrome from a single shared codebase**. It is not published; it is loaded
unpacked/temporary and used by one person.

It automates four independent things:

1. **Databricks login (email code)** — fills the email on the Databricks login
   page, then reads the one-time code out of Gmail and submits it.
2. **AWS access portal** — on `awsapps.com/start`, expands an account and
   clicks a permission-set (role) to open the console.
3. **Definity app magic-link login (Chrome only)** — fills the email on
   `app|dev.definity.run/login`, reads the magic link out of Gmail, and
   navigates the tab to it.
4. **Definity tenant impersonation (Chrome only)** — a popup menu that
   impersonates a tenant by navigating to `?tid=<id>` (see below).

Common infrastructure: a background script opens Gmail in a hidden/minimized
window, injects a scraper, and relays the result back to the page.

## Repository layout

| File | Role |
|---|---|
| `manifest.json` | **Firefox** manifest (Manifest V2, persistent background page) |
| `manifest.chrome.json` | **Chrome** manifest (Manifest V3); `build-chrome.sh` renames it to `manifest.json` in the build dir |
| `sw.js` | Chrome MV3 service-worker entry: `importScripts("config.js","background.js")` |
| `build-chrome.sh` | Assembles `build/chrome/` (shared files + the MV3 manifest) |
| `config.js` | `chrome`→`browser` shim, `DBX_DEFAULTS`, and `loadConfig()` |
| `background.js` | Orchestrator: opens Gmail, injects scrapers, relays results, badge, background-driven toast |
| `content-databricks.js` | Databricks login page: fills email/code, submits (segmented OTP) |
| `content-aws.js` | `awsapps.com/start`: expand account, click role (text matching) |
| `content-definity.js` | Definity login page (Chrome): fills email, triggers the magic-link flow |
| `gmail-extract.js` | Injected into Gmail; scrapes the Databricks **code**. Self-contained. |
| `gmail-link-extract.js` | Injected into Gmail; scrapes the Definity **magic link**. Self-contained. |
| `options.html` / `options.js` | Settings UI (writes `browser.storage.local`) |
| `popup.html` / `popup.js` | Toolbar popup: "Run login now", options link, and the Impersonate menu |
| `README.md` | User-facing install + tuning notes |

`build/` and `.DS_Store` are gitignored. Do not commit `build/`.

## Cross-browser architecture (important)

One set of logic files runs in both browsers. Differences are handled in three
places only:

1. **Namespace shim.** Chrome exposes `chrome` (with promises in MV3); Firefox
   exposes `browser`. The top of `config.js`, `popup.js`, and **each injected
   scraper** does:
   ```js
   if (typeof globalThis.browser === "undefined" && typeof chrome !== "undefined") {
     globalThis.browser = chrome;
   }
   ```
   After this, all code uses `browser.*` with promises.

2. **Two manifests.** Firefox loads the repo root (`manifest.json`, MV2). Chrome
   loads `build/chrome/` produced by `./build-chrome.sh` (MV3 with `sw.js`).
   Chrome-only features (Definity login + impersonation, definity host perms)
   are wired **only in `manifest.chrome.json`**, so they are inert on Firefox.

3. **Feature detection in `background.js`:**
   - Badge: `const badgeAction = browser.action || browser.browserAction;`
     (MV3 `action` vs MV2 `browserAction`).
   - Injection: prefer `browser.tabs.executeScript` (MV2) when present, else
     `browser.scripting.executeScript` (MV3).
   - Hidden Gmail: `browser.tabs.hide()` (Firefox) vs a **minimized, unfocused
     popup window** (Chrome — it has no way to fully hide a tab, so Gmail may
     flash briefly).

## Runtime flow (how the pieces talk)

Databricks / Definity share a background "flow" keyed by `kind`
(`"databricks"` or `"definity"`):

```
content script (fills form, clicks submit)
   │  runtime.sendMessage {type:"startFlow", kind}
   ▼
background.startFlow(kind)
   - stores flowStartTs
   - opens Gmail (hidden tab / minimized window) at a #search/ URL
   - injects the scraper (gmail-extract.js OR gmail-link-extract.js)
   ▼
scraper (in the Gmail tab)
   - waits for a FRESH matching email (see "old email" gotcha)
   - extracts code / link; optionally trashes the email
   - runtime.sendMessage {type:"gmailCode"|"gmailLink"|"gmailError", ...}
   - also forwards its logs via {type:"gmailLog"} (the tab closes too fast to read)
   ▼
background
   - databricks: stores pendingCode + sends {type:"fillCode"} to the page
   - definity:  shows a success toast, then tabs.update() to the magic link
   - closes the Gmail tab/window
```

Message types: `startFlow{kind}`, `gmailLog`, `gmailCode`, `gmailError`,
`gmailLink`, `fillCode`, `flowError`, `manualStart`.

Key `storage.local` keys used at runtime: `pendingCode`/`pendingCodeTs`
(code handoff, survives navigation), `flowActive`/`flowActiveTs` (gates the
Databricks code-entry watcher so toasts don't fire on already-logged-in pages),
`flowStartTs` (freshness gate for the Gmail scrapers), plus all config keys.

AWS and impersonation do **not** use the background flow:
- AWS: `content-aws.js` acts entirely on the page (text matching).
- **Impersonation: no DOM automation and no API call.** The Definity app has a
  route loader (`authRouterLoader` → `tenantImpersonationLoader`, on the root
  `/` route) that impersonates a tenant when the URL has `?tid=<id>` (super-admin
  only). `popup.js` just navigates the active tab to `<current-url>?tid=<id>`.
  Reference: `~/dev/definity-app/frontend/src/.../tenantImpersonationLoader.ts`
  and `SuperAdmin.utils.ts` (`impersonateTenant`). Prefer this kind of
  "reuse the app's own mechanism" approach over clicking the UI.

## Configuration

`config.js` defines `DBX_DEFAULTS` and `loadConfig()` (reads
`browser.storage.local`, merged over defaults). The options page
(`options.html`/`options.js`) writes those keys. Notable keys: `email`,
`gmailAccountIndex`, `gmailSearchQuery`, `codeRegex`, `definityEmail`,
`definitySearchQuery`, `impersonateTenants` (array of `{name,id}`),
`awsAccount`, `awsRole`, `hideGmailTab`, `showToast`, `trashDbxEmail`,
`gmailTimeoutMs`, `debug`.

**Gotcha:** the two injected scrapers are **self-contained** and re-declare a
small subset of these defaults inline (they cannot rely on `config.js` — see
the executeScript gotcha below). If you change a default that a scraper reads
(`codeRegex`, `gmailTimeoutMs`, `trashDbxEmail`, `definitySearchQuery`, etc.),
update it in **both** `config.js` and the scraper's `localConfig()`.

## Building & loading

- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on
  → pick the repo-root `manifest.json`. Re-load with the **Reload** button after
  edits. (Temporary add-ons vanish on restart.)
- **Chrome:** `./build-chrome.sh` then `chrome://extensions` → Developer mode →
  Load unpacked → `build/chrome`. **Re-run `./build-chrome.sh` after every edit**
  and click the reload icon.

Prerequisite for all Gmail flows: the developer must already be **logged into
Gmail in the same browser profile** (the hidden Gmail tab reuses that session).

## Debugging

There are **no automated tests** and this cannot be run headless — everything is
verified by loading the extension and reading logs against the real pages.

**Log prefixes** (all gated on `debug`, default on):
`[definity-databricks]`, `[definity-aws]`, `[definity-app]` (content scripts),
`[definity-bg]` (background), `[definity-gmail]` / `[definity-gmail-link]`
(injected scrapers).

**Where logs appear:**
- **Content-script logs** (`[definity-databricks]`, `[definity-aws]`,
  `[definity-app]`) go to the **page's own console** — open DevTools (F12) on
  that tab. They do **not** appear in Firefox's Browser Console by default.
- **Background logs** (`[definity-bg]`):
  - Firefox: `about:debugging` → this extension → **Inspect**.
  - Chrome: `chrome://extensions` → this extension → **service worker** (Inspect).
- **Gmail scraper logs** (`[definity-gmail]`, `[definity-gmail-link]`) run in the
  hidden Gmail tab, which **closes too fast to read**. They are **forwarded to
  the background console** via `{type:"gmailLog"}` and logged there with the
  `[definity-gmail...]` prefix. Watch the background console, not the Gmail tab.

When a selector fails, the code dumps candidates so you can retarget without
seeing the DOM yourself — look for lines like `visible buttons: [...]`,
`visible inputs: [...]`, `clickable candidates: [...]`, `row action labels: ...`,
`top row text: ...`, `no Delete control. visible button labels: ...`. Ask the
developer to paste these, then fix the selector.

## Known-fragile areas & how they work (the hard-won lessons)

- **Gmail DOM selectors** are the most fragile thing here. Rows are `tr.zA`,
  message body is `div.a3s`. These are obfuscated Google classes; they have been
  stable but can change. Tune via the logged dumps.
- **Firefox `executeScript` does NOT share scope across calls.** Top-level
  functions from one `tabs.executeScript` file are not reliably visible to a
  later one. This is why the Gmail scrapers are **self-contained** (own shim,
  read `storage` directly, no `loadConfig`). Do **not** reintroduce a dependency
  on `config.js` being injected alongside a scraper.
- **Segmented OTP input** (Databricks): the code boxes are bare `<input>` with
  **no `type` attribute**, so a CSS selector like `input[type="text"]` misses
  them. Match by the `.type` *property* (defaults to `"text"`). Fill **one
  character per box**, firing `keydown`/`input`/`keyup` per box so the widget
  advances focus. The code (e.g. `ABC-DEF`) is stripped of non-alphanumerics.
- **React/Angular value setting:** setting `.value` is not enough. Use the
  native value setter + dispatch `input`/`change` (see `setNativeValue`).
- **Icon buttons** (AWS role click, Gmail toolbar) usually have no visible text —
  match on `aria-label`/`title`/`data-tooltip`, not `innerText`.
- **The status toast can match itself.** `content-aws.js` once clicked its own
  toast because it contained the target text. `findByText`/`findAllByText`
  exclude `#dbx-autologin-status`. Keep that exclusion.
- **Hidden Gmail tab has a collapsed toolbar**, so the conversation-view Delete
  button is hidden in an overflow. Deletion therefore uses the **result-row
  hover Delete action** (`trashRow`): dispatch mouseover on the row, find a
  descendant whose label contains "delete"/"trash", click it. The link scraper
  reads the body first (link is in the body), then returns to the list via the
  search hash to delete.
- **"Grabbed an old code/link" race.** The Gmail search can render before the
  new email arrives, so the scraper would take the previous one. Fix:
  `waitForFreshRow()` reads each candidate row's timestamp (from its date
  `span[title]`) and rejects anything older than `flowStartTs` minus a 120s
  skew tolerance, clicking Gmail **Refresh** and polling until the fresh email
  appears. If the timestamp can't be parsed it degrades to accepting the top row
  (and logs a warning). The 120s tolerance means a re-login within ~2 min could
  still match a prior email — tighten only if clock drift is known-small.
- **Gmail rewrites links** to `https://www.google.com/url?q=<real>`. The link
  scraper unwraps this so navigation goes straight to the target.
- **Trashing is move-to-Trash only** (reversible, 30-day recovery). Never
  implement permanent deletion / emptying Trash.

## Testing / verifying a change

1. `node --check <file>.js` on every edited JS file (catches syntax errors;
   there is no build/lint step otherwise).
2. Validate manifests: `python3 -c "import json; json.load(open('manifest.json')); json.load(open('manifest.chrome.json'))"`.
3. `./build-chrome.sh` to confirm the Chrome build assembles.
4. Reload the extension in the target browser and exercise the real flow with
   the relevant console open. State plainly which browser you actually tested
   and which you only reasoned about — the two manifests diverge and a change
   can pass on one and break the other (e.g. a Firefox regression from a
   Chrome-oriented change).

## Working with this developer

- The developer's global preferences (see `~/.claude/CLAUDE.md`) apply: **simple,
  short English**; **restate context** (no bare pronouns; give `file:line`);
  **stop and report access failures** rather than working around them.
- **Be honest about verification.** This project can't be tested headless, so
  always say what you actually checked (`node --check`, a build) versus what you
  only reasoned about. Do not claim a flow works if you only edited code.
- **Selectors need real DOM.** When a page-interaction step is uncertain, add
  logging that dumps candidate elements and ask the developer to run it and
  paste the output, rather than guessing repeatedly. This is the established
  debugging loop here.
- **Prefer robust mechanisms over brittle DOM clicking** when the target app
  exposes one (the impersonation `?tid=` param is the model example — found by
  reading `~/dev/definity-app`).
- **Surgical changes.** Keep the working Firefox path intact when adding Chrome
  behavior; gate new browser-specific features in the appropriate manifest.
- **Git:** the developer works directly on `main`. Commit only when asked; end
  commit messages with the `Co-Authored-By: Claude ...` trailer. Do not push
  unless asked.
