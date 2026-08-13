// Builds the same-looking Brief/Detailed report PDF as the in-app
// "Download PDF" button (src/App.jsx Reports component), for the
// scheduled daily email. Runs in Node (Vercel serverless), not the
// browser — jsPDF ships a Node-specific build for exactly this.

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export function buildReportPdf({ reportType, companyName, columns, rows, summary, windowLabel, generatedLabel }) {
  const doc = new jsPDF({ orientation: reportType === "detailed" ? "landscape" : "portrait", unit: "pt" });
  const name = companyName || "Ausgroup";

  doc.setFontSize(14);
  doc.text(`${name} Alarm Response Dispatch — ${reportType === "brief" ? "Brief" : "Detailed"} Report`, 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(`Reporting period: ${windowLabel}`, 40, 58);
  doc.text(`Generated ${generatedLabel}`, 40, 72);

  autoTable(doc, {
    startY: 86,
    head: [columns],
    body: rows,
    styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [255, 176, 32], textColor: [20, 20, 20] },
    columnStyles: reportType === "detailed" ? { 11: { cellWidth: 160 }, 12: { cellWidth: 160 } } : undefined,
  });

  const summaryStartY = (doc.lastAutoTable?.finalY || 86) + 26;
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text("Patrolman response summary", 40, summaryStartY);
  autoTable(doc, {
    startY: summaryStartY + 8,
    head: [["Patrolman", "Run", "Responses"]],
    body: summary.map((s) => [s.patrolman, s.run, String(s.count)]),
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [255, 176, 32], textColor: [20, 20, 20] },
    tableWidth: 300,
  });

  return Buffer.from(doc.output("arraybuffer"));
}
