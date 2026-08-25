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

import { kvGet, kvSet } from "./supabase.js";

const JOBS_KEY = "ops:jobs";
export const JOB_ARCHIVE_PREFIX = "ops:jobarchive:";

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
    const terminalAt = j.status === "emailed" ? j.emailedAt : j.status === "cancelled" ? j.cancelledAt : null;
    if (terminalAt && nowMs - new Date(terminalAt).getTime() >= ARCHIVE_AFTER_MS) {
      toArchive.push(j);
    } else {
      remaining.push(j);
    }
  }
  if (toArchive.length === 0) return { archived: 0, remaining: jobs.length };

  for (const j of toArchive) {
    await kvSet(`${JOB_ARCHIVE_PREFIX}${j.id}`, JSON.stringify(j));
  }
  await kvSet(JOBS_KEY, JSON.stringify(remaining));
  return { archived: toArchive.length, remaining: remaining.length };
}
