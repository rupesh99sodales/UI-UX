console.log("Content script loaded");

//
(async function injectAxe() {
  if (window.axe) return; //load
  try {
    const resp = await chrome.runtime.sendMessage({ type: "INJECT_AXE" });
    if (resp?.ok) console.log("AXE injected");
    else console.warn("AXE injection failed", resp?.error);
  } catch (e) {
    console.warn("AXE inject error", e);
  }
})();

//FUNCTION

function generateSelector(el) {
  if (!el) return "";
  if (el.id) return `#${el.id}`;
  const parts = [];
  let current = el;
  while (current && current.nodeType === 1) {
    let part = current.tagName.toLowerCase();
    if (current.className) {
      const cls = current.className.split(/\s+/)[0];
      if (cls) part += "." + cls.replace(/[^a-z0-9_-]/gi, "");
    }
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return (
    style &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    el.getClientRects().length > 0
  );
}

function getHtmlSnippet(el) {
  try {
    return el.outerHTML || el.textContent || "";
  } catch {
    return "";
  }
}

//SCREENSHOT

function captureElementImage(selector) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (!el) return resolve(null);

    el.scrollIntoView({ behavior: "auto", block: "center" });
    const rect = el.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;

    chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, (resp) => {
      if (!resp?.ok) return resolve(null);

      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = rect.width * scale;
          canvas.height = rect.height * scale;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(
            img,
            (rect.left + window.scrollX) * scale,
            (rect.top + window.scrollY) * scale,
            rect.width * scale,
            rect.height * scale,
            0,
            0,
            rect.width * scale,
            rect.height * scale
          );
          resolve(canvas.toDataURL("image/png"));
        } catch (err) {
          console.error("Snapshot error:", err);
          resolve(null);
        }
      };
      img.src = resp.dataUrl;
    });
  });
}

//

function runCustomHeuristics() {
  const issues = [];

  // Images missing alt
  document.querySelectorAll("img").forEach((img) => {
    if (!isVisible(img)) return;
    const role = (img.getAttribute("role") || "").toLowerCase();
    const hiddenAttr = img.getAttribute("aria-hidden");
    if (role === "presentation" || role === "none" || hiddenAttr === "true")
      return;

    const alt = img.getAttribute("alt") || "";
    if (!alt.trim()) {
      issues.push({
        rule: "image-alt",
        impact: "minor",
        description: "Image missing alt text",
        selector: generateSelector(img),
        html: getHtmlSnippet(img),
      });
    }
  });

  // Form controls missing labels
  document
    .querySelectorAll("input, textarea, select, [role='textbox']")
    .forEach((el) => {
      if (!isVisible(el)) return;
      const labelled =
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby") ||
        (el.id && document.querySelector(`[for='${el.id}']`));
      if (!labelled) {
        issues.push({
          rule: "form-label",
          impact: "minor",
          description: "Form control missing accessible label",
          selector: generateSelector(el),
          html: getHtmlSnippet(el),
        });
      }
    });

  // Dialog name
  document.querySelectorAll("[role]").forEach((el) => {
    const role = el.getAttribute("role") || "";
    if (!role.toLowerCase().includes("dialog")) return;

    const name =
      el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
    if (!name) {
      issues.push({
        rule: "dialog-name",
        impact: "serious",
        description: "Dialog missing accessible name",
        selector: generateSelector(el),
        html: getHtmlSnippet(el),
      });
    }
  });

  // Tables missing headers
  document.querySelectorAll("table").forEach((table) => {
    const headers = table.querySelectorAll(
      "th, [role='columnheader'], [role='rowheader']"
    );
    if (headers.length === 0) {
      issues.push({
        rule: "table-headers",
        impact: "serious",
        description: "Table missing header cells",
        selector: generateSelector(table),
        html: getHtmlSnippet(table),
      });
    }
  });

  // Duplicate IDs
  const ids = {};
  document.querySelectorAll("[id]").forEach((el) => {
    const id = el.id;
    if (!id) return;
    ids[id] = (ids[id] || 0) + 1;
  });
  Object.keys(ids).forEach((id) => {
    if (ids[id] > 1) {
      issues.push({
        rule: "duplicate-id",
        impact: "serious",
        description: `Duplicate id "${id}" found ${ids[id]} times`,
        selector: `[id="${id}"]`,
        html: "",
      });
    }
  });

  // Focusability
  document
    .querySelectorAll(
      "a, button, input, textarea, select, [role='button'], [role='link']"
    )
    .forEach((el) => {
      if (!isVisible(el)) return;
      const isFocusable = !el.hasAttribute("disabled") && el.tabIndex >= 0;
      if (!isFocusable) {
        issues.push({
          rule: "not-focusable",
          impact: "serious",
          description: "Interactive element not keyboard focusable",
          selector: generateSelector(el),
          html: getHtmlSnippet(el),
        });
      }
    });

  return issues;
}

//SCAN from all

window._FULL_SCAN = async function (options = {}) {
  const results = { axe: {}, custom: [], meta: {}, csv: [] };

  //

  try {
    if (window.axe) {
      const axeResults = await window.axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
      });

      results.axe = axeResults;

      // Capture snapshots and assign group for CSV
      for (const group of ["violations", "incomplete", "passes"]) {
        for (const issue of axeResults[group] || []) {
          for (const node of issue.nodes) {
            const selector = node.target?.[0];
            node.snapshot = selector
              ? await captureElementImage(selector)
              : null;

            // Push to CSV array with group
            results.csv.push({
              Source: "AXE",
              Group: group,
              Rule: issue.id || "",
              Impact: issue.impact || "",
              Description: issue.help || issue.description || "",
              Selector: selector || "",
              HTML: node.html || "",
              Snapshot: node.snapshot || "",
            });
          }
        }
      }
    }
  } catch (e) {
    results.axeError = e.message;
  }

  //Custom heuristics + snapshots
  results.custom = runCustomHeuristics();
  for (const c of results.custom) {
    c.snapshot = await captureElementImage(c.selector);
    results.csv.push({
      Source: "Custom",
      Group: "custom",
      Rule: c.rule,
      Impact: c.impact || "minor",
      Description: c.description,
      Selector: c.selector,
      HTML: c.html,
      Snapshot: c.snapshot || "",
    });
  }

  //TIME
  results.meta = {
    timestamp: Date.now(),
    url: location.href,
  };

  return { ok: true, results };
};

//

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RUN_SCAN") {
    window._FULL_SCAN(msg.options).then((r) => sendResponse(r));
    return true;
  }
  if (msg.type === "CAPTURE_SNIPPET") {
    captureElementImage(msg.selector).then((data) =>
      sendResponse({ ok: true, dataUrl: data })
    );
    return true;
  }
});
