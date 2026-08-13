// Shared, framework-free report-building logic used by both the in-app
// Reports tab (src/App.jsx, runs in the browser) and the scheduled daily
// email (api/daily-report.js, runs in a Node serverless function).
//
// Every date helper takes an optional IANA `timeZone` (e.g.
// "Australia/Sydney"). Omitting it formats in whatever timezone the code
// is currently running in — the browser's local zone in the app, or UTC
// on Vercel's servers, which is why the serverless function always passes
// one explicitly.

export const STATUS_META = {
  dispatched: { label: "Dispatched", color: "var(--info)" },
  submitted: { label: "Awaiting review", color: "var(--warn)" },
  reviewed: { label: "Reviewed", color: "#7C3AED" },
  emailed: { label: "Sent to client", color: "var(--ok)" },
  cancelled: { label: "Cancelled", color: "var(--text-dim)" },
};

export function fmtTime(iso, timeZone) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-AU", {
    hour: "2-digit", minute: "2-digit", hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

export function fmtDateTime(iso, timeZone) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-AU", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

function zonedParts(iso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") === "24" ? "00" : get("hour"), minute: get("minute") };
}

export function isoDateOnly(iso, timeZone) {
  const d = new Date(iso);
  if (timeZone) {
    const p = zonedParts(iso, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isoTimeOnly(iso, timeZone) {
  const d = new Date(iso);
  if (timeZone) {
    const p = zonedParts(iso, timeZone);
    return `${p.hour}:${p.minute}`;
  }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function reportStatusLabel(status) {
  if (status === "cancelled") return "Cancelled";
  if (status === "emailed") return "Completed";
  return STATUS_META[status]?.label || status;
}

export const REPORT_COLUMNS_BRIEF = ["Job #", "Date", "Time", "Site", "Run", "Patrolman attended", "Operator (dispatched)", "Finalized by", "Status"];
export const REPORT_COLUMNS_DETAILED = [...REPORT_COLUMNS_BRIEF, "Onsite time", "Offsite time", "Results", "Alarm description"];

export function reportRow(job, reportType, timeZone) {
  const base = [
    job.jobNumber,
    isoDateOnly(job.dispatchTime, timeZone),
    isoTimeOnly(job.dispatchTime, timeZone),
    job.siteName,
    job.run || "—",
    job.assigneeName || "—",
    job.dispatchedByName || "—",
    job.handlingName || "—",
    reportStatusLabel(job.status),
  ];
  if (reportType === "brief") return base;
  return [
    ...base,
    job.onsiteTime ? fmtDateTime(job.onsiteTime, timeZone) : "—",
    job.offsiteTime ? fmtDateTime(job.offsiteTime, timeZone) : "—",
    job.reviewNotes || job.outcomeNotes || "—",
    job.description || "—",
  ];
}

export function patrolmanRunSummary(filteredJobs) {
  const byKey = {};
  filteredJobs.forEach((j) => {
    const patrolman = j.assigneeName || "Unassigned";
    const run = j.run || "Unassigned";
    const key = `${patrolman}||${run}`;
    byKey[key] = byKey[key] || { patrolman, run, count: 0 };
    byKey[key].count++;
  });
  return Object.values(byKey).sort((a, b) => b.count - a.count || a.patrolman.localeCompare(b.patrolman));
}
