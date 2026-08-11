# Definity Auto Login (Firefox + Chrome)

Auto-fills the Databricks login email, waits for the verification-code email
in Gmail, extracts the code, then fills and submits it. You do nothing.
Also automates the AWS access portal (expand account, click role).

Runs on **both Firefox and Chrome** from one shared codebase — see
"Cross-browser build" below.

## How it works

1. `content-databricks.js` runs on the Databricks login page. It fills your
   email and clicks "send code", then tells the background script.
2. `background.js` opens a **hidden, background** Gmail tab at a search URL
   (you never open a tab yourself).
3. `gmail-extract.js` is injected into that tab. It opens the newest matching
   email, pulls the 6-digit code out with a regex, and sends it back.
4. The code is filled into the Databricks form and submitted. The Gmail tab
   is closed.

```
Databricks page          background            hidden Gmail tab
  fill email + send  ──▶  open Gmail tab  ──▶   scrape newest code
  fill code + submit ◀──  relay code      ◀──   send code back
```

## Prerequisite

- You must **already be logged into Gmail** in the same Firefox profile.
  The background tab reuses your existing Gmail session cookie. The extension
  never handles your Gmail password.

## Install (temporary, for testing)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` in this folder.
4. Open the extension's **options** (about:addons → this add-on → Preferences,
   or the popup's "Open options" link) and set:
   - **Login email** — the address for the Databricks form.
   - **Gmail account index** — 0 for your first Gmail account.
   - Leave the search query and regex at their defaults to start.

Temporary add-ons are removed when Firefox restarts. To make it permanent you
must sign/package it (see "Making it permanent" below).

## Install (temporary, for testing) — Chrome

1. Build the Chrome folder (MV3): `./build-chrome.sh` → creates `build/chrome/`.
2. Open `chrome://extensions`, enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `build/chrome` folder.
4. Open the extension's **options** (three-dot menu → Options, or the popup's
   "Open options" link) and set the same values as above.

You must be **logged into Gmail in the same Chrome profile** (same rule as
Firefox).

## Cross-browser build

One shared codebase, two manifests:

- **Firefox** loads the repo root directly. `manifest.json` is Manifest V2 with
  a persistent background page.
- **Chrome** loads `build/chrome/`, where `build-chrome.sh` copies the shared
  files and renames `manifest.chrome.json` → `manifest.json` (Manifest V3 with
  a `sw.js` service worker).

The logic files are identical across browsers. Compatibility is handled by:

- A one-line shim (top of `config.js`, and `popup.js`) that aliases Chrome's
  `chrome` namespace to `browser`. Chrome's MV3 APIs are promise-based, so the
  rest of the code is unchanged.
- Feature detection in `background.js` for the three APIs that differ:
  `action` vs `browserAction` (badge), `scripting.executeScript` vs
  `tabs.executeScript` (injection), and `tabs.hide()` vs a minimized popup
  window (the invisible Gmail tab).

**The one behavior difference:** Firefox truly hides the Gmail tab
(`tabs.hide()`). Chrome has no such API, so it opens Gmail in a **minimized,
unfocused popup window** instead — as close to invisible as Chrome allows; it
may briefly appear. Everything else behaves the same.

Re-run `./build-chrome.sh` after editing any source file, then click the
reload icon on the Chrome extensions page.

## Trying it

- With auto-start on (default), just open the Databricks login page. It should
  fill, send, wait, and submit on its own.
- Or click the toolbar button → **Run login now** to trigger manually.
- Open the **Browser Console** (Ctrl+Shift+J) to watch the logs from all three
  parts (`[definity-databricks]`, `[definity-bg]`, `[definity-gmail]`).

## AWS access portal (awsapps.com/start)

A second automation, independent of the Databricks/Gmail flow. On the AWS
access portal it expands a configured account and clicks a configured role
(permission set), which opens the console.

- Set **AWS account name** (default `dev-admin`) and **AWS role / permission
  set** (default `PowerUserAccess`) in options.
- With **Auto-run when the AWS access portal loads** on, it runs automatically
  on `awsapps.com/start`. Or use the toolbar button → **Run login now**.
- It matches the account and role **by visible text**, since the portal is a
  React app with no stable ids. If a step fails, the console (`[definity-aws]`) logs
  the clickable candidates so you can correct the text in options.

## Definity app magic-link login (Chrome only)

Automates the magic-link login for Definity's own app
(`app.definity.run/login` and `dev.definity.run/login`). Wired only in the
Chrome manifest, so it does nothing in Firefox.

Flow:
1. `content-definity.js` fills your email and clicks the login button.
2. The background opens Gmail and injects `gmail-link-extract.js`, which finds
   the newest email matching `from:no-reply@definity.ai Login` and reads the
   login link out of the message body (unwrapping Gmail's `google.com/url`
   redirect).
3. The background navigates your login tab straight to that link, signing you
   in.

Options (Chrome): **Definity login email** (blank falls back to the Databricks
Login email) and **Definity email search query**. Same Gmail prerequisite —
you must be signed into Gmail in the Chrome profile.

## Status indicators

While the flow runs you get two forms of feedback:

- **On-page toast** (top-right of the Databricks tab): a spinner with
  "Filling your email…" → "Waiting for the code email…" → "Code received —
  entering it…" → a green "Logging you in…" that fades out. A red toast shows
  if the code never arrives or the flow errors. Turn it off with **Show the
  on-page status toast** in options.
- **Toolbar icon badge**: amber "…" while waiting, green "✓" when the code
  lands, red "!" on error. Visible even when you are on another tab.

The toast only appears during a real login. It is gated on a short-lived
`flowActive` flag, so reloading the extension while already logged in does not
show a stray "Waiting…" toast.

## The parts most likely to need tuning

I cannot see your real pages, so these selectors are best guesses:

- **Databricks form** — `content-databricks.js` finds the email input, code
  input, and buttons by common patterns (`input[type=email]`,
  `autocomplete=one-time-code`, button text like "send"/"verify"). If it
  misses, the console log tells you what it found. Adjust `findEmailInput`,
  `findCodeInput`, or `findButton`.
- **Gmail body** — `gmail-extract.js` uses Gmail's `.zA` (result row) and
  `.a3s` (message body) classes. These are stable but not guaranteed. If the
  code is not found, the log prints the first 300 chars of the body so you can
  fix the regex or selector.
- **The code email filter** — the Gmail search query
  (`from:databricks newer_than:1h`) in options. Adjust `from:` to the real
  sender if needed (check the actual code email's From address).

## Notes and limits

- **Trashing the code email:** with **Move the Databricks code email to Trash
  after reading it** on (default), the scraper opens the newest matching email,
  reads the code, then clicks Gmail's Delete (move-to-trash) button. This is
  reversible — the email sits in Gmail's Trash and is recoverable for 30 days.
  The extension never empties Trash or hard-deletes. Only the one email it read
  the code from is trashed.
- **Stale codes:** `newer_than:1h` plus "newest match first" avoids grabbing an
  old code. If you log in twice within an hour, the newest email is still the
  right one because Gmail sorts newest first.
- **Manifests:** Firefox uses MV2 (root `manifest.json`); Chrome uses MV3
  (`build/chrome/manifest.json`). See "Cross-browser build" above.
- **Security:** the extension reads your Gmail page content and auto-submits a
  login code for your own account. It stores only your login email and settings
  in `browser.storage.local`. No passwords are handled or sent anywhere.

## Making it permanent

Temporary add-ons vanish on restart. To keep it:

- Package the folder into a `.zip`, then submit to
  [addons.mozilla.org](https://addons.mozilla.org/developers/) for signing
  (can be self-hosted/unlisted), **or**
- Use the `web-ext` tool (`npx web-ext run` to test, `web-ext sign` to get a
  signed build with a Mozilla API key).

## Files

| File | Role |
|---|---|
| `manifest.json` | Firefox manifest (MV2) |
| `manifest.chrome.json` | Chrome manifest (MV3); renamed to manifest.json by the build |
| `sw.js` | Chrome service-worker entry (`importScripts` config + background) |
| `build-chrome.sh` | Assembles `build/chrome/` for Chrome |
| `config.js` | `browser`/`chrome` shim + default settings + `loadConfig()` |
| `background.js` | Orchestrates the flow, opens/closes the Gmail tab/window |
| `content-databricks.js` | Fills email/code and submits on the login page |
| `content-aws.js` | Expands the AWS account and clicks the role on awsapps.com/start |
| `gmail-extract.js` | Injected into Gmail; scrapes the code |
| `gmail-link-extract.js` | Injected into Gmail; scrapes the Definity magic link |
| `content-definity.js` | Definity app login (Chrome only); fills email, triggers link flow |
| `options.html` / `options.js` | Settings UI |
| `popup.html` / `popup.js` | Toolbar button (manual run + options link) |
# firefox-dbx-login
