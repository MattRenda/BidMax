// BidMax Service Worker v2

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get('bidmax_settings', res => {
      sendResponse({ settings: res.bidmax_settings || {} });
    });
    return true;
  }

  if (msg.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({ bidmax_settings: msg.settings }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
