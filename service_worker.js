console.log("Service worker running...");

//

async function injectOnce(tabId, varName, file) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: (v) => window[v] !== undefined,
        args: [varName],
      },
      (res) => {
        const alreadyLoaded = res?.[0]?.result;
        if (alreadyLoaded) {
          console.log(`[SKIP] ${file} already loaded`);
          return resolve(true);
        }
        console.log(`[INJECT] ${file}`);
        chrome.scripting.executeScript(
          { target: { tabId }, files: [file] },
          (res) => {
            if (chrome.runtime.lastError) {
              console.error(
                `[ERROR] Failed to inject ${file}:`,
                chrome.runtime.lastError.message ||
                  chrome.runtime.lastError ||
                  "Unknown error"
              );
              return resolve(false);
            }
            resolve(true);
          }
        );
      }
    );
  });
}

//

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return false;

  console.log("Service worker received message:", msg.type);

  //axe.min.js call

  if (msg.type === "INJECT_AXE") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) return sendResponse({ ok: false, error: "No active tab" });

      const injected = await injectOnce(tabId, "axe", "axe.min.js");
      sendResponse({ ok: injected });
    });
    return true;
  }

  //SNAPSHOT

  if (msg.type === "CAPTURE_SCREENSHOT") {
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError)
        return sendResponse({
          ok: false,
          error: chrome.runtime.lastError.message,
        });

      sendResponse({ ok: true, dataUrl });
    });
    return true;
  }

  //

  if (msg.type === "CAPTURE_SNIPPET") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, msg, (resp) =>
        sendResponse(resp || { ok: false })
      );
    });
    return true;
  }

  //FULL SCAN

  if (msg.type === "RUN_SCAN") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) return sendResponse({ ok: false, error: "No active tab" });

      // Inject AXE first
      await injectOnce(tabId, "axe", "axe.min.js");

      // Inject content script once
      await injectOnce(tabId, "_FULL_SCAN", "content_script.js");

      // Trigger scan in content script
      chrome.tabs.sendMessage(
        tabId,
        { type: "RUN_SCAN", options: msg.options },
        (resp) => sendResponse(resp || { ok: false })
      );
    });
    return true;
  }

  return false;
});
