// Moves long-closed jobs out of the board's polled ops:jobs blob and into
// their own per-job key (ops:jobarchive:<id>) — same idea as jobphotos.js,
// applied to the job record itself instead of just its photos. Every
// signed-in device polls ops:jobs, so keeping months of closed-out history
// in there forever both wastes that poll and risks ops:jobs eventually
// hitting Vercel's 4.5MB request/response cap.
//
// Also the point where attendance photos actually stop costing anything:
// photos are by far the largest thing this app stores, so right before a
// job is archived, its photos are emailed as a backup attachment (see
// backupAndDeletePhotos below) and then deleted from Supabase — the
// archived job keeps its text (result, activity log) forever, but the
// photo bytes don't pile up past the 48-hour window they're useful for
// in-app.
//
// Run once daily from api/daily-report.js (the only existing cron on this
// project's Hobby plan) rather than on every read — a full sweep+rewrite
// on every poll would be wasteful and racy against concurrent job edits;
// once a day is plenty for a size problem that grows over weeks, not
// minutes.

import { isMailConfigured, getMailFrom, createMailTransporter } from "./mail.js";
import { kvGet, kvSet, kvSetSearchable, kvGetPrefixMissingSearch, kvQueryPrefix, kvDelete } from "./supabase.js";
import { fmtDateTime } from "../../src/reportUtils.js";

const JOBS_KEY = "ops:jobs";
export const JOB_ARCHIVE_PREFIX = "ops:jobarchive:";
export const JOB_PHOTOS_PREFIX = "ops:jobphotos:";
export const JOB_CHAT_PREFIX = "ops:jobchat:";

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

// Vercel's servers run in UTC — without this, the backup email's times
// would be shifted from what Control Room actually sees in the app.
// Same default as api/daily-report.js.
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "Australia/Sydney";

// Runs `fn` over `items` with at most `limit` in flight at once — used
// below so a backlog of jobs to archive (each needing its own SMTP round
// trip for the photo backup, plus a couple of Supabase calls) runs
// concurrently instead of one at a time. Sequential was the actual cause
// of this whole cron timing out on a day with more than a handful of
// jobs queued up: at up to 10s per SMTP call (see createMailTransporter's
// timeouts), even a modest backlog blew straight through the 60s ceiling
// (vercel.json) before the function ever reached building or sending the
// report itself. Each item here touches its own job's keys, never a
// shared one, so running them in parallel doesn't introduce a race.
async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function photoAttachmentsFor(job, photos) {
  return photos
    .map((p, i) => {
      const match = /^data:([^;]+);base64,(.*)$/.exec(p.dataUrl || "");
      if (!match) return null;
      const [, contentType, content] = match;
      const ext = contentType.split("/")[1] || "jpg";
      return { filename: `${job.jobNumber || job.id}-photo-${i + 1}.${ext}`, content, encoding: "base64", contentType };
    })
    .filter(Boolean);
}

// Emails a job's attendance photos to the company's own backup inbox and
// deletes them from Supabase — called once per job right before it's
// archived. Most jobs never reach this still needing to send: closing or
// cancelling a job already fires this same email immediately, client-side
// (see sendPhotoBackupEmail in src/App.jsx), and stamps `photosBackedUpAt`
// on success — this is just the guaranteed fallback for whatever that
// missed (a dropped connection, a job closed via "Mark as sent/closed",
// etc). Left in place (and simply retried on the next day's cron) if
// sending fails or isn't configured, so a bad send or a missing env var
// never loses the only copy of a photo.
async function backupAndDeletePhotos(job, { transporter } = {}) {
  const photosKey = `${JOB_PHOTOS_PREFIX}${job.id}`;
  const raw = await kvGet(photosKey);
  if (!raw) return "none";

  let photos;
  try { photos = JSON.parse(raw); } catch (e) { return "none"; }
  if (!Array.isArray(photos) || photos.length === 0) {
    await kvDelete(photosKey);
    return "none";
  }

  if (job.photosBackedUpAt) {
    await kvDelete(photosKey);
    return "already-sent";
  }

  const to = process.env.JOB_BACKUP_RECIPIENTS;
  if (!to || !isMailConfigured()) return "not-configured";

  const attachments = photoAttachmentsFor(job, photos);
  if (!attachments.length) {
    await kvDelete(photosKey);
    return "none";
  }

  const subject = `Attendance photo backup — ${job.jobNumber || job.id}${job.siteName ? ` — ${job.siteName}` : ""}`;
  const text = [
    `Job ${job.jobNumber || job.id} — ${job.siteName || "—"}`,
    `Address: ${job.address || "—"}`,
    `Status: ${job.status === "cancelled" ? "Cancelled" : "Closed"}`,
    `Patrolman: ${job.assigneeName || "—"}`,
    `Dispatched: ${fmtDateTime(job.dispatchTime, REPORT_TIMEZONE)}`,
    `Onsite: ${fmtDateTime(job.onsiteTime, REPORT_TIMEZONE)}`,
    `Offsite: ${fmtDateTime(job.offsiteTime, REPORT_TIMEZONE)}`,
    `Outcome: ${job.reviewNotes || job.cancelReason || "—"}`,
    ``,
    `${attachments.length} attendance photo${attachments.length !== 1 ? "s" : ""} attached — this is the only copy kept once this job is archived.`,
  ].join("\n");

  try {
    const send = transporter || createMailTransporter();
    await send.sendMail({ from: getMailFrom(), to, subject, text, attachments });
  } catch (err) {
    console.error(`photo backup email failed for job ${job.id}:`, err);
    return "failed";
  }
  await kvDelete(photosKey);
  return "sent";
}

// One-time (safe to re-run) catch-up for jobs whose photo backup email
// never went out — notably every job that got archived while outbound
// mail was blocked (see README). archiveOldJobs() above only retries a
// failed send for as long as a job is still on the live ops:jobs list;
// once a job's 48h sweep runs, it moves to the archive and drops out of
// that list for good, so a failure during that exact sweep stranded its
// photos in Supabase with no further retry ever scheduled. This instead
// walks every JOB_PHOTOS_PREFIX row not tied to a still-live job — i.e.
// exactly the ones archiveOldJobs will never look at again — and reuses
// backupAndDeletePhotos to resend and clean each one up now that mail is
// working. Capped at 500 rows per call (kvQueryPrefix's ordering is most
// recently touched first) — call again if the result reports exactly 500
// checked, since more may remain.
export async function backfillOrphanedPhotoBackups({ transporter } = {}) {
  const [liveRaw, photoRows] = await Promise.all([
    kvGet(JOBS_KEY),
    kvQueryPrefix(JOB_PHOTOS_PREFIX, { limit: 500 }),
  ]);

  let liveJobs;
  try { liveJobs = JSON.parse(liveRaw || "[]"); } catch (e) { liveJobs = []; }
  const liveIds = new Set((Array.isArray(liveJobs) ? liveJobs : []).map((j) => j.id));

  const orphaned = photoRows.filter((row) => !liveIds.has(row.key.slice(JOB_PHOTOS_PREFIX.length)));

  const counts = { sent: 0, none: 0, failed: 0, "not-configured": 0, "already-sent": 0 };
  await mapWithConcurrency(orphaned, 5, async (row) => {
    const id = row.key.slice(JOB_PHOTOS_PREFIX.length);
    const archivedRaw = await kvGet(`${JOB_ARCHIVE_PREFIX}${id}`);
    let job = null;
    try { job = archivedRaw ? JSON.parse(archivedRaw) : null; } catch (e) { job = null; }
    if (!job) job = { id }; // archive record missing/malformed — still recover the photos with whatever we've got
    const outcome = await backupAndDeletePhotos(job, { transporter });
    counts[outcome] = (counts[outcome] || 0) + 1;
  });

  return { checked: photoRows.length, orphaned: orphaned.length, ...counts };
}

// Job chat lives in its own key while a job is live (see api/kv.js) so
// the board's poll never carries chat text for jobs nobody has open —
// folded directly into the archived job record here (unlike photos,
// plain text is cheap enough to just keep forever) so it's still there
// when someone looks this job up by number later, then the live key is
// deleted since nothing will ever poll it again once archived.
async function archiveChat(job) {
  const chatKey = `${JOB_CHAT_PREFIX}${job.id}`;
  const raw = await kvGet(chatKey);
  if (!raw) return null;
  await kvDelete(chatKey);
  try {
    const chat = JSON.parse(raw);
    return Array.isArray(chat) && chat.length ? chat : null;
  } catch (e) {
    return null;
  }
}

export async function archiveOldJobs(now = new Date(), { transporter } = {}) {
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

  const photoBackupCounts = { sent: 0, none: 0, failed: 0, "not-configured": 0, "already-sent": 0 };
  if (toArchive.length > 0) {
    await mapWithConcurrency(toArchive, 5, async (j) => {
      const outcome = await backupAndDeletePhotos(j, { transporter });
      photoBackupCounts[outcome] = (photoBackupCounts[outcome] || 0) + 1;
      const chat = await archiveChat(j);
      const archivedJob = chat ? { ...j, chat } : j;
      await kvSetSearchable(`${JOB_ARCHIVE_PREFIX}${j.id}`, JSON.stringify(archivedJob), searchFieldsFor(j));
    });
    await kvSet(JOBS_KEY, JSON.stringify(remaining));
  }

  const backfilled = await backfillSearchFields();

  return { archived: toArchive.length, remaining: remaining.length, backfilled, photoBackupCounts };
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
  await mapWithConcurrency(rows, 10, async (r) => {
    let job;
    try { job = JSON.parse(r.value); } catch (e) { return; }
    await kvSetSearchable(r.key, r.value, searchFieldsFor(job));
  });
  return rows.length;
}
