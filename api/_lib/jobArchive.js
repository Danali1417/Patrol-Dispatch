// Moves long-closed jobs out of the board's polled ops:jobs blob and into
// their own per-job key (ops:jobarchive:<id>) — same idea as jobphotos.js,
// applied to the job record itself instead of just its photos. Every
// signed-in device polls ops:jobs every 4 seconds, so keeping months of
// closed-out history in there forever both wastes that poll and risks
// ops:jobs eventually hitting Vercel's 4.5MB request/response cap.
//
// Run once daily from api/daily-report.js (the only existing cron on this
// project's Hobby plan) rather than on every read — a full sweep+rewrite
// on every 4-second poll would be wasteful and racy against concurrent
// job edits; once a day is plenty for a size problem that grows over
// weeks, not minutes.

import { kvGet, kvSet, kvSetSearchable, kvGetPrefixMissingSearch } from "./supabase.js";

const JOBS_KEY = "ops:jobs";
export const JOB_ARCHIVE_PREFIX = "ops:jobarchive:";

// {jobNumber, siteName, dispatchDate} — small enough to index, and
// everything Board's archive search / Logs & analysis' date range
// actually filter by. dispatchDate is a plain YYYY-MM-DD (UTC) slice,
// not timezone-aware — precise enough for "which week/month" filtering.
function searchFieldsFor(job) {
  return {
    jobNumber: job.jobNumber || "",
    siteName: job.siteName || "",
    dispatchDate: (job.dispatchTime || "").slice(0, 10),
  };
}

// Closed jobs stay on the live board for 2 days after they finish — long
// enough for Control Room to amend a result or re-send a client email —
// before moving to the archive. "Closed jobs" / "Cancelled jobs" only
// show what's still on the live board; Logs & analysis pulls the archive
// back in for anything older, so nothing is actually lost.
const ARCHIVE_AFTER_MS = 48 * 60 * 60 * 1000;

export async function archiveOldJobs(now = new Date()) {
  const raw = await kvGet(JOBS_KEY);
  if (!raw) return { archived: 0, remaining: 0 };
  let jobs;
  try { jobs = JSON.parse(raw); } catch (e) { return { archived: 0, remaining: 0 }; }
  if (!Array.isArray(jobs)) return { archived: 0, remaining: 0 };

  const nowMs = now.getTime();
  const toArchive = [];
  const remaining = [];
  for (const j of jobs) {
    const isTerminal = j.status === "emailed" || j.status === "cancelled";
    // Jobs closed by an older version of the app may be missing their own
    // emailedAt/cancelledAt — falling back to dispatchTime (always set)
    // means a genuinely old, genuinely terminal job still gets swept up
    // instead of sitting on the live board forever for lack of one field.
    const terminalAt = isTerminal ? (j.status === "emailed" ? j.emailedAt : j.cancelledAt) || j.dispatchTime : null;
    if (terminalAt && nowMs - new Date(terminalAt).getTime() >= ARCHIVE_AFTER_MS) {
      toArchive.push(j);
    } else {
      remaining.push(j);
    }
  }
  if (toArchive.length > 0) {
    for (const j of toArchive) {
      await kvSetSearchable(`${JOB_ARCHIVE_PREFIX}${j.id}`, JSON.stringify(j), searchFieldsFor(j));
    }
    await kvSet(JOBS_KEY, JSON.stringify(remaining));
  }

  const backfilled = await backfillSearchFields();

  return { archived: toArchive.length, remaining: remaining.length, backfilled };
}

// One-time catch-up for jobs archived before the `search` column existed
// (see README) — always queries only rows still missing it (capped),
// never the whole archive, so this stays cheap both before the backfill
// finishes and forever after (query returns nothing once none are left).
async function backfillSearchFields() {
  let rows;
  try {
    rows = await kvGetPrefixMissingSearch(JOB_ARCHIVE_PREFIX);
  } catch (e) {
    return 0;
  }
  for (const r of rows) {
    let job;
    try { job = JSON.parse(r.value); } catch (e) { continue; }
    await kvSetSearchable(r.key, r.value, searchFieldsFor(job));
  }
  return rows.length;
}
