const FIELDS = {
  email: "value",
  gmailAccountIndex: "value",
  gmailSearchQuery: "value",
  codeRegex: "value",
  gmailTimeoutMs: "value",
  awsAccount: "value",
  awsRole: "value",
  awsAutoStart: "checked",
  definityEmail: "value",
  definitySearchQuery: "value",
  autoStart: "checked",
  hideGmailTab: "checked",
  trashDbxEmail: "checked",
  showToast: "checked",
  debug: "checked"
};

async function restore() {
  const cfg = await loadConfig();
  for (const [id, prop] of Object.entries(FIELDS)) {
    const el = document.getElementById(id);
    if (el) el[prop] = cfg[id];
  }
}

async function save() {
  const out = {};
  for (const [id, prop] of Object.entries(FIELDS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    let v = el[prop];
    if (id === "gmailAccountIndex" || id === "gmailTimeoutMs") v = Number(v);
    out[id] = v;
  }
  await browser.storage.local.set(out);
  const s = document.getElementById("status");
  s.textContent = "Saved.";
  setTimeout(() => (s.textContent = ""), 1500);
}

document.getElementById("save").addEventListener("click", save);
restore();
