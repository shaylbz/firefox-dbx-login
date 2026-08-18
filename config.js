// Cross-browser shim: Chrome exposes `chrome` (with promises on MV3), Firefox
// exposes `browser`. Alias so the rest of the code can always use `browser`.
if (typeof globalThis.browser === "undefined" && typeof chrome !== "undefined") {
  globalThis.browser = chrome;
}

// Shared default config. Loaded by background, content scripts read via storage.
// This file defines defaults only; live values live in browser.storage.local.

const DBX_DEFAULTS = {
  // The email address to type into the Databricks login form.
  email: "",

  // Which Gmail account (the /u/<N>/ index). 0 is the first account.
  gmailAccountIndex: 0,

  // Gmail search query used to find the code email. Newest match is used.
  // `newer_than:1h` guards against grabbing a stale code from earlier.
  gmailSearchQuery: "from:databricks newer_than:1h",

  // Regex (as a string) to pull the code out of the email text.
  // Databricks sends a word-style code, e.g. "...verification code is ABC-DEF".
  // Capture group 1 is used as the code.
  codeRegex: "verification code is[:\\s]+([A-Z0-9-]{5,})",

  // Fill + send automatically when the Databricks login page loads.
  autoStart: true,

  // --- Definity app magic-link login (Chrome only) -------------------------
  // Email to type into the definity.run login form. Falls back to `email`.
  definityEmail: "",
  // Gmail search for the magic-link email. Newest match is used.
  definitySearchQuery: "from:no-reply@definity.ai Login newer_than:1h",
  // Tenants shown in the popup "Impersonate" menu on definity.run.
  impersonateTenants: [
    { name: "grammarly.com", id: 29 },
    { name: "pubmatic.com", id: 63 },
    { name: "vitality.com", id: 61 },
    { name: "nexxen.com", id: 3 }
  ],

  // --- AWS access portal (awsapps.com/start) -------------------------------
  // The account name to expand and the permission-set (role) to open.
  awsAccount: "dev-admin",
  awsRole: "PowerUserAccess",
  // Auto-run when the AWS access portal loads.
  awsAutoStart: true,

  // Hide the temporary Gmail tab from the tab strip (needs tabHide permission).
  hideGmailTab: true,

  // Show the on-page status toast (top-right of the Databricks tab).
  showToast: true,

  // How long to keep polling Gmail for the code before giving up (ms).
  gmailTimeoutMs: 60000,

  // After reading the code, move that Databricks email to Trash (reversible;
  // recoverable in Gmail's Trash for 30 days). Only the one email that the
  // code was read from is trashed.
  trashDbxEmail: true,

  // Verbose console logging in all parts of the extension.
  debug: true
};

async function loadConfig() {
  const stored = await browser.storage.local.get(DBX_DEFAULTS);
  return { ...DBX_DEFAULTS, ...stored };
}
