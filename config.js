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

  // Hide the temporary Gmail tab from the tab strip (needs tabHide permission).
  hideGmailTab: true,

  // Show the on-page status toast (top-right of the Databricks tab).
  showToast: true,

  // How long to keep polling Gmail for the code before giving up (ms).
  gmailTimeoutMs: 60000,

  // Verbose console logging in all parts of the extension.
  debug: true
};

async function loadConfig() {
  const stored = await browser.storage.local.get(DBX_DEFAULTS);
  return { ...DBX_DEFAULTS, ...stored };
}
