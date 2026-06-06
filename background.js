browser.browserAction.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL("ratings.html") });
});

browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg || msg.type !== "fetch") return;
  try {
    const resp = await fetch(msg.url, { credentials: msg.credentials || "omit" });
    return { ok: resp.ok, status: resp.status, text: await resp.text() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
});
