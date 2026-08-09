# Databricks Email-Code Auto Login (Firefox)

Auto-fills the Databricks login email, waits for the verification-code email
in Gmail, extracts the code, then fills and submits it. You do nothing.

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

## Trying it

- With auto-start on (default), just open the Databricks login page. It should
  fill, send, wait, and submit on its own.
- Or click the toolbar button → **Run login now** to trigger manually.
- Open the **Browser Console** (Ctrl+Shift+J) to watch the logs from all three
  parts (`[dbx-content]`, `[dbx-bg]`, `[dbx-gmail]`).

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

- **Stale codes:** `newer_than:1h` plus "newest match first" avoids grabbing an
  old code. If you log in twice within an hour, the newest email is still the
  right one because Gmail sorts newest first.
- **Manifest V2:** used for a simpler background page. Firefox supports it.
  Migrating to MV3 later means switching to an event/service worker and
  `action` instead of `browser_action`.
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
| `manifest.json` | Extension manifest (MV2) |
| `config.js` | Default settings + `loadConfig()` |
| `background.js` | Orchestrates the flow, opens/closes the Gmail tab |
| `content-databricks.js` | Fills email/code and submits on the login page |
| `gmail-extract.js` | Injected into Gmail; scrapes the code |
| `options.html` / `options.js` | Settings UI |
| `popup.html` / `popup.js` | Toolbar button (manual run + options link) |
# firefox-dbx-login
