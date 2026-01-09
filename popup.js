if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPopup);
} else {
  initPopup();
}

function initPopup() {
  console.log("Popup initialized");

  const scanBtn = document.getElementById("scanBtn");
  const exportCsvBtn = document.getElementById("exportCsvBtn");
  const exportPdfBtn = document.getElementById("exportPdfBtn");
  const statusEl = document.getElementById("status");
  const resultsEl = document.getElementById("results");
  const totalCount = document.getElementById("totalCount");

  if (!scanBtn || !exportCsvBtn || !exportPdfBtn) {
    console.error("Missing required DOM elements");
    return;
  }

  let lastResult = null;

  //
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function sendMessageToBackground(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
    });
  }

  //SCAN

  scanBtn.addEventListener("click", async () => {
    resultsEl.innerHTML = "";
    totalCount.textContent = "Total: 0";

    exportCsvBtn.disabled = true;
    exportPdfBtn.disabled = true;

    setStatus("Preparing scan…");

    try {
      const injectAxeResp = await sendMessageToBackground({
        type: "INJECT_AXE",
      });
      if (!injectAxeResp?.ok) {
        setStatus("Failed to inject AXE: " + injectAxeResp?.error);
        return;
      }

      setStatus("Running full-page scan…");

      const resp = await sendMessageToBackground({
        type: "RUN_SCAN",
        options: { stabilizeMs: 2500, autoScroll: true },
      });

      if (!resp?.ok) {
        setStatus("Scan failed: " + (resp?.error || "Unknown error"));
        return;
      }

      lastResult = resp.results;

      if (!lastResult) {
        setStatus("Scan completed but no results found.");
        return;
      }

      renderResults(lastResult);

      exportCsvBtn.disabled = false;
      exportPdfBtn.disabled = false;

      setStatus(
        "Scan complete. Total issues: " + (lastResult.csv?.length || 0)
      );
    } catch (e) {
      console.error("Scan error:", e);
      setStatus("Error: " + e.message);
    }
  });

  // EXPORT CSV

  exportCsvBtn.addEventListener("click", () => {
    if (!lastResult?.csv?.length) {
      setStatus("No data to export");
      return;
    }

    const csv = buildCSV(lastResult.csv);
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");

    a.href = URL.createObjectURL(blob);
    a.download = `accessibility_report_${Date.now()}.csv`;
    a.click();

    setStatus("CSV exported");
  });

  //EXPORT PDF

  exportPdfBtn.addEventListener("click", async () => {
    if (!lastResult) {
      setStatus("No data to export");
      return;
    }

    setStatus("Generating PDF…");

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF("p", "pt", "a4");
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 20;
    let y = margin;

    // Title
    doc.setFontSize(18);
    doc.text("Accessibility / UX Report", margin, y);
    y += 30;

    // Meta info
    doc.setFontSize(10);
    doc.text(`URL: ${lastResult.meta.url}`, margin, y);
    y += 15;
    doc.text(
      `Date: ${new Date(lastResult.meta.timestamp).toLocaleString()}`,
      margin,
      y
    );
    y += 20;

    const allIssues = [];

    // AXE + CUSTOM issues
    ["violations", "incomplete", "passes"].forEach((group) => {
      (lastResult.axe?.[group] || []).forEach((issue) => {
        issue.nodes.forEach((node) => {
          allIssues.push({
            source: "AXE",
            group: group,
            rule: issue.id,
            impact: issue.impact,
            description: issue.help || issue.description,
            selector: node.target?.[0] || "",
            snapshot: node.snapshot || null,
          });
        });
      });
    });

    // Custom heuristics
    (lastResult.custom || []).forEach((c) => {
      allIssues.push({
        source: "Custom",
        group: "custom",
        rule: c.rule,
        impact: c.impact || "minor",
        description: c.description,
        selector: c.selector,
        snapshot: c.snapshot || null,
      });
    });
    // Helper to color-code issues
    function getIssueColor(issue) {
      switch (issue.group) {
        case "violations":
          return "#FF0000"; // red
        case "incomplete":
          return "#FFA500"; // orange
        case "passes":
          return "#008000"; // green
        case "custom":
          return "#0000FF"; // blue
        default:
          return "#000000"; //black
      }
    }
    // Render PDF
    for (const issue of allIssues) {
      const lineHeight = 15;
      const spacing = 10;

      if (y + 3 * lineHeight + spacing > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }

      doc.setFontSize(12);
      doc.setTextColor(getIssueColor(issue));
      doc.text(
        `[${issue.source}] [${issue.group}] [${issue.impact}] Rule: ${issue.rule}`,
        margin,
        y
      );
      y += lineHeight;

      doc.setFontSize(10);
      doc.text(`Description: ${issue.description}`, margin, y);
      y += lineHeight;

      doc.text(`Selector: ${issue.selector}`, margin, y);
      y += lineHeight;

      if (issue.snapshot) {
        try {
          const imgProps = doc.getImageProperties(issue.snapshot);
          const pdfWidth = Math.min(400, pageWidth - margin * 2);
          const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

          if (y + pdfHeight > pageHeight - margin) {
            doc.addPage();
            y = margin;
          }

          doc.addImage(issue.snapshot, "PNG", margin, y, pdfWidth, pdfHeight);
          y += pdfHeight + spacing;
        } catch (err) {
          console.warn("Error adding image:", err);
          y += spacing;
        }
      } else {
        y += spacing;
      }

      y += spacing;
    }

    doc.save(`UX_Report_${Date.now()}.pdf`);
    setStatus("PDF Exported");
  });

  //RENDER RESULTS

  function renderResults(full) {
    resultsEl.innerHTML = "";
    let count = 0;

    function createCard(source, group, impact, rule, desc, selector, snapshot) {
      count++;
      const div = document.createElement("div");
      div.className = "issue-card";

      div.innerHTML = `
        <div class="issue-title">[${source}] [${group}] [${impact}] ${rule}</div>
        <div class="issue-desc">${desc}</div>
        ${snapshot ? `<img class="snapshot-thumb" src="${snapshot}">` : ""}
        <div class="issue-meta"><small>${selector}</small></div>
      `;

      resultsEl.appendChild(div);
    }

    const axe = full.axe || {};
    const custom = full.custom || [];

    ["violations", "incomplete", "passes"].forEach((group) => {
      (axe[group] || []).forEach((issue) => {
        issue.nodes.forEach((node) => {
          createCard(
            "AXE",
            group,
            issue.impact,
            issue.id,
            issue.help || issue.description,
            node.target?.[0],
            node.snapshot
          );
        });
      });
    });

    custom.forEach((c) =>
      createCard(
        "Custom",
        "custom",
        c.impact || "minor",
        c.rule,
        c.description,
        c.selector,
        c.snapshot
      )
    );

    totalCount.textContent = "Total: " + count;
  }

  // EXCEL FORMAT OF Columns
  function buildCSV(rows) {
    return [
      ["Source", "Group", "Rule", "Impact", "Description", "Selector", "HTML"]
        .map((c) => `"${c}"`)
        .join(","),
      ...rows.map((r) =>
        [
          r.Source,
          r.Group,
          r.Rule,
          r.Impact,
          r.Description,
          r.Selector,
          (r.HTML || "").replace(/\n/g, " "),
        ]
          .map((c) => `"${String(c).replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n");
  }
}
