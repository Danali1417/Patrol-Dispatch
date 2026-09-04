// Builds the same-looking Brief/Detailed report PDF as the in-app
// "Download PDF" button (src/App.jsx Reports component), for the
// scheduled daily email. Runs in Node (Vercel serverless), not the
// browser — jsPDF ships a Node-specific build for exactly this.

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

const SUMMARY_TABLE_OPTS = {
  styles: { fontSize: 8, cellPadding: 4 },
  headStyles: { fillColor: [255, 176, 32], textColor: [20, 20, 20] },
  footStyles: { fillColor: [235, 235, 235], textColor: [20, 20, 20], fontStyle: "bold" },
  tableWidth: 300,
};

export function buildReportPdf({ reportType, companyName, columns, rows, summary, operators, cancelledCount, windowLabel, generatedLabel }) {
  const doc = new jsPDF({ orientation: reportType === "detailed" ? "landscape" : "portrait", unit: "pt" });
  const name = companyName || "Ausgroup";

  doc.setFontSize(14);
  doc.text(`${name} Alarm Response Dispatch — ${reportType === "brief" ? "Brief" : "Detailed"} Report`, 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(`Reporting period: ${windowLabel}`, 40, 58);
  doc.text(`Generated ${generatedLabel}`, 40, 72);
  doc.text(`${rows.length} job(s) — ${cancelledCount ?? 0} cancelled`, 40, 86);

  autoTable(doc, {
    startY: 100,
    head: [columns],
    body: rows,
    styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [255, 176, 32], textColor: [20, 20, 20] },
    columnStyles: reportType === "detailed" ? { 11: { cellWidth: 160 }, 12: { cellWidth: 160 } } : undefined,
  });

  const totalResponses = summary.reduce((sum, s) => sum + s.count, 0);
  const summaryStartY = (doc.lastAutoTable?.finalY || 100) + 26;
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text("Patrolman response summary", 40, summaryStartY);
  autoTable(doc, {
    startY: summaryStartY + 8,
    head: [["Patrolman", "Run", "Responses"]],
    body: summary.map((s) => [s.patrolman, s.run, String(s.count)]),
    foot: [["Total", "", String(totalResponses)]],
    ...SUMMARY_TABLE_OPTS,
  });

  const totalDispatched = (operators || []).reduce((sum, o) => sum + o.dispatched, 0);
  const totalFinalized = (operators || []).reduce((sum, o) => sum + o.finalized, 0);
  const totalCancelled = (operators || []).reduce((sum, o) => sum + o.cancelled, 0);
  const operatorStartY = (doc.lastAutoTable?.finalY || summaryStartY) + 26;
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text("Operator summary", 40, operatorStartY);
  autoTable(doc, {
    startY: operatorStartY + 8,
    head: [["Operator", "Dispatched", "Finalized", "Cancelled"]],
    body: (operators || []).map((o) => [o.operator, String(o.dispatched), String(o.finalized), String(o.cancelled)]),
    foot: [["Total", String(totalDispatched), String(totalFinalized), String(totalCancelled)]],
    ...SUMMARY_TABLE_OPTS,
  });

  return Buffer.from(doc.output("arraybuffer"));
}
