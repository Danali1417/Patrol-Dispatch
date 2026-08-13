import { buildReportPdf } from "./pdf.js";
import { fmtDateTime } from "../../src/reportUtils.js";

// Builds the Brief + Detailed PDFs and the message body/attachments, then
// sends via the given nodemailer `transporter`. Transporter is injected so
// tests can swap in nodemailer's JSON/stream transport (no network) instead
// of the real Gmail one.
export async function sendReportEmail({ data, recipients, from, transporter, now = new Date() }) {
  const { window, companyName, filteredJobs, briefRows, detailedRows, summary, columnsBrief, columnsDetailed } = data;
  const windowLabel = `${window.startLabel} – ${window.endLabel}`;
  const generatedLabel = fmtDateTime(now.toISOString(), "Australia/Sydney");

  const briefPdf = buildReportPdf({
    reportType: "brief", companyName, columns: columnsBrief, rows: briefRows, summary, windowLabel, generatedLabel,
  });
  const detailedPdf = buildReportPdf({
    reportType: "detailed", companyName, columns: columnsDetailed, rows: detailedRows, summary, windowLabel, generatedLabel,
  });

  const summaryLines = summary.length
    ? summary.map((s) => `- ${s.patrolman} on ${s.run} — ${s.count} response${s.count !== 1 ? "s" : ""}`).join("\n")
    : "No jobs dispatched in this period.";

  const subject = `${companyName} Alarm Response Dispatch — Daily Report — ${windowLabel}`;
  const text = [
    `Daily report for ${windowLabel}.`,
    ``,
    `${filteredJobs.length} job(s) dispatched in this period.`,
    ``,
    `Patrolman response summary:`,
    summaryLines,
    ``,
    `Full Brief and Detailed reports are attached as PDFs.`,
  ].join("\n");

  const info = await transporter.sendMail({
    from,
    to: recipients,
    subject,
    text,
    attachments: [
      { filename: `brief-report-${window.dateKey}.pdf`, content: briefPdf },
      { filename: `detailed-report-${window.dateKey}.pdf`, content: detailedPdf },
    ],
  });

  return { info, subject, briefPdf, detailedPdf };
}
