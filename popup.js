if (typeof globalThis.browser === "undefined" && typeof chrome !== "undefined") {
  globalThis.browser = chrome;
}

document.getElementById("run").addEventListener("click", async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    await browser.tabs.sendMessage(tab.id, { type: "manualStart" }).catch(() => {
      // Not on a supported page; ignore.
    });
  }
  window.close();
});

document.getElementById("opts").addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});

// Show the Impersonate menu only when the active tab is on definity.run.
(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    host = tab && tab.url ? new URL(tab.url).host : "";
  } catch (e) {}
  if (!/\.?definity\.run$/.test(host)) return;

  const cfg = await loadConfig();
  const list = document.getElementById("tenant-list");
  (cfg.impersonateTenants || []).forEach((t) => {
    const b = document.createElement("button");
    b.className = "tenant";
    b.innerHTML = "";
    b.append(t.name + " ");
    const small = document.createElement("small");
    small.textContent = "(id " + t.id + ")";
    b.append(small);
    b.addEventListener("click", async () => {
      // The app impersonates a tenant from a `?tid=<id>` param on any app route
      // (super-admin only). Just navigate the current tab there.
      let target;
      try {
        const u = new URL(tab.url);
        u.searchParams.set("tid", String(t.id));
        target = u.toString();
      } catch (e) {
        return;
      }
      await browser.tabs.update(tab.id, { url: target });
      window.close();
    });
    list.appendChild(b);
  });
  document.getElementById("impersonate").style.display = "block";
})();
