if (typeof globalThis.browser === "undefined" && typeof chrome !== "undefined") {
  globalThis.browser = chrome;
}

document.getElementById("run").addEventListener("click", async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    await browser.tabs.sendMessage(tab.id, { type: "manualStart" }).catch(() => {
      // Not on a Databricks page; ignore.
    });
  }
  window.close();
});

document.getElementById("opts").addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});
