// Shared, framework-free report-building logic used by both the in-app
// Reports tab (src/App.jsx, runs in the browser) and the scheduled daily
// email (api/daily-report.js, runs in a Node serverless function).
//
// Every date helper takes an optional IANA `timeZone` (e.g.
// "Australia/Sydney"). Omitting it formats in whatever timezone the code
// is currently running in — the browser's local zone in the app, or UTC
// on Vercel's servers, which is why the serverless function always passes
// one explicitly.

// A job dispatched before job types existed (or a plain alarm response)
// has no jobType at all — treated as "response" everywhere, matching
// src/App.jsx's own definition (kept in sync manually since that file
// can't import from here without a circular dependency the other way).
export const JOB_TYPES = [
  { id: "response", label: "Response" },
  { id: "randomPatrol", label: "Random Patrol" },
  { id: "keyPickup", label: "Key Pickup" },
  { id: "keyDropoff", label: "Key Drop Off" },
];
export function jobTypeLabel(jobType) {
  return JOB_TYPES.find((t) => t.id === jobType)?.label || "Response";
}
export function isResponseJob(job) {
  return (job.jobType || "response") === "response";
}

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

// Night Patrol runs 1800-0600, spanning midnight — a roster entry for an
// overnight shift is stored under the date it starts (the evening it's
// rostered from). Matches src/App.jsx's own rosterDateISO()/
// ROSTER_DAY_ROLLOVER_HOUR (that function is now a thin wrapper around
// this one, for "today"); kept here too since resolveRosterEntry below
// needs it for an arbitrary job's dispatch time, not just "now".
export const ROSTER_DAY_ROLLOVER_HOUR = 6;
export function rosterDateFor(iso, timeZone) {
  const dateOnly = isoDateOnly(iso, timeZone);
  const hour = Number(isoTimeOnly(iso, timeZone).split(":")[0]);
  if (hour >= ROSTER_DAY_ROLLOVER_HOUR) return dateOnly;
  const [y, m, d] = dateOnly.split("-").map(Number);
  const rolled = new Date(Date.UTC(y, m - 1, d - 1));
  return `${rolled.getUTCFullYear()}-${String(rolled.getUTCMonth() + 1).padStart(2, "0")}-${String(rolled.getUTCDate()).padStart(2, "0")}`;
}

// A site's own "default run/zone" (set once, when the site was created)
// gets snapshotted onto a job as `job.run` at dispatch time as a
// fallback when the assigned patrolman isn't rostered anywhere that day
// — useful for picking a sensible default while dispatching, but wrong
// to treat as ground truth afterwards: the roster is what actually says
// who's on which run for a given shift, and it can be corrected or
// changed after a job's already gone out without that job's snapshot
// ever catching up. Reports resolve the roster entry for the job's own
// dispatch date (rollover-aware) and assignee, falling back to the job's
// stored run/name only when nobody was actually rostered that day (an ad
// hoc dispatch, or a job older than the roster feature itself).
function resolveRosterEntry(job, roster, timeZone) {
  if (!roster || !job.assigneeId) return null;
  const rosterDate = rosterDateFor(job.dispatchTime, timeZone);
  return roster.find((r) => r.date === rosterDate && r.patrolmanLoginName === job.assigneeId) || null;
}

export const REPORT_COLUMNS_BRIEF = ["Job #", "Type", "Date", "Time", "Site", "Run", "Patrolman attended", "Operator (dispatched)", "Finalized by", "Status"];
export const REPORT_COLUMNS_DETAILED = [...REPORT_COLUMNS_BRIEF, "Onsite time", "Offsite time", "Results", "Alarm description"];

export function reportRow(job, reportType, timeZone, roster) {
  const rosterEntry = resolveRosterEntry(job, roster, timeZone);
  const base = [
    job.jobNumber,
    jobTypeLabel(job.jobType),
    isoDateOnly(job.dispatchTime, timeZone),
    isoTimeOnly(job.dispatchTime, timeZone),
    job.siteName,
    rosterEntry?.run || job.run || "—",
    rosterEntry?.patrolmanName || job.assigneeName || "—",
    job.dispatchedByName || "—",
    job.handlingName || "—",
    reportStatusLabel(job.status),
  ];
  if (reportType === "brief") return base;
  return [
    ...base,
    job.onsiteTime ? fmtDateTime(job.onsiteTime, timeZone) : "—",
    job.offsiteTime ? fmtDateTime(job.offsiteTime, timeZone) : "—",
    job.reviewNotes || job.outcomeNotes || job.cancelReason || "—",
    job.description || "—",
  ];
}

export function patrolmanRunSummary(filteredJobs, roster, timeZone) {
  const byKey = {};
  filteredJobs.forEach((j) => {
    const rosterEntry = resolveRosterEntry(j, roster, timeZone);
    const patrolman = rosterEntry?.patrolmanName || j.assigneeName || "Unassigned";
    const run = rosterEntry?.run || j.run || "Unassigned";
    const key = `${patrolman}||${run}`;
    byKey[key] = byKey[key] || { patrolman, run, count: 0 };
    byKey[key].count++;
  });
  return Object.values(byKey).sort((a, b) => b.count - a.count || a.patrolman.localeCompare(b.patrolman));
}

// One row per Control Room operator who dispatched, finalized or
// cancelled at least one job in range. "Dispatched" comes straight from
// dispatchedByName (set once, at dispatch time, on every job).
// "Finalized" only counts a job once it's actually been sent to the
// client (status "emailed"), credited to whoever's shown handling it —
// the same field the "Finalized by" report column already uses, so this
// stays consistent with what each job row says. "Cancelled" is credited
// to whoever actually cancelled it (cancelledByName) — a job someone
// cancelled on another operator's behalf still counts theirs, not the
// dispatcher's or current handler's. A job cancelled before that field
// existed falls back to handlingName instead — the same "Finalized by"
// field the report row already shows for it — rather than going
// uncredited forever.
export function operatorSummary(filteredJobs) {
  const byOperator = {};
  function ensure(name) {
    if (!name) return null;
    byOperator[name] = byOperator[name] || { operator: name, dispatched: 0, finalized: 0, cancelled: 0 };
    return byOperator[name];
  }
  filteredJobs.forEach((j) => {
    const dispatcher = ensure(j.dispatchedByName);
    if (dispatcher) dispatcher.dispatched++;
    if (j.status === "emailed") {
      const finalizer = ensure(j.handlingName);
      if (finalizer) finalizer.finalized++;
    }
    if (j.status === "cancelled") {
      const canceller = ensure(j.cancelledByName || j.handlingName);
      if (canceller) canceller.cancelled++;
    }
  });
  return Object.values(byOperator).sort((a, b) => b.dispatched - a.dispatched || a.operator.localeCompare(b.operator));
}

export function cancelledJobCount(filteredJobs) {
  return filteredJobs.filter((j) => j.status === "cancelled").length;
}

// One row per job type actually seen in range (omits types nobody
// dispatched that period, same sparse style as operatorSummary), sorted
// highest count first — the breakdown the daily report and Reports tab
// use to show patrols/response/key pickup/key drop-off separately instead
// of one lumped-together job count.
export function jobTypeCounts(filteredJobs) {
  const byType = {};
  filteredJobs.forEach((j) => {
    const id = j.jobType || "response";
    byType[id] = (byType[id] || 0) + 1;
  });
  return JOB_TYPES
    .filter((t) => byType[t.id] > 0)
    .map((t) => ({ jobType: t.id, label: t.label, count: byType[t.id] }))
    .sort((a, b) => b.count - a.count);
}
