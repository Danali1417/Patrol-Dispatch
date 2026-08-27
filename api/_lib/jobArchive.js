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

import nodemailer from "nodemailer";
import { kvGet, kvSet, kvSetSearchable, kvGetPrefixMissingSearch, kvDelete } from "./supabase.js";

const JOBS_KEY = "ops:jobs";
export const JOB_ARCHIVE_PREFIX = "ops:jobarchive:";
export const JOB_PHOTOS_PREFIX = "ops:jobphotos:";

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

function defaultTransporter() {
  // Short timeouts (nodemailer defaults to up to 2 minutes) so one bad
  // connection can't eat the whole 60s cron budget (vercel.json) and
  // starve every other job still waiting for its own backup this run.
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
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

  const to = process.env.REPORT_RECIPIENTS;
  if (!to || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return "not-configured";

  const attachments = photoAttachmentsFor(job, photos);
  if (!attachments.length) {
    await kvDelete(photosKey);
    return "none";
  }

  const subject = `Attendance photo backup — ${job.jobNumber || job.id}${job.siteName ? ` — ${job.siteName}` : ""}`;
  const text = [
    `Job ${job.jobNumber || job.id} — ${job.siteName || "—"}`,
    `Status: ${job.status === "cancelled" ? "Cancelled" : "Closed"}`,
    `Patrolman: ${job.assigneeName || "—"}`,
    `Outcome: ${job.reviewNotes || job.cancelReason || "—"}`,
    ``,
    `${attachments.length} attendance photo${attachments.length !== 1 ? "s" : ""} attached — this is the only copy kept once this job is archived.`,
  ].join("\n");

  try {
    const send = transporter || defaultTransporter();
    await send.sendMail({ from: process.env.GMAIL_USER, to, subject, text, attachments });
  } catch (err) {
    console.error(`photo backup email failed for job ${job.id}:`, err);
    return "failed";
  }
  await kvDelete(photosKey);
  return "sent";
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
    for (const j of toArchive) {
      const outcome = await backupAndDeletePhotos(j, { transporter });
      photoBackupCounts[outcome] = (photoBackupCounts[outcome] || 0) + 1;
      await kvSetSearchable(`${JOB_ARCHIVE_PREFIX}${j.id}`, JSON.stringify(j), searchFieldsFor(j));
    }
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
  for (const r of rows) {
    let job;
    try { job = JSON.parse(r.value); } catch (e) { continue; }
    await kvSetSearchable(r.key, r.value, searchFieldsFor(job));
  }
  return rows.length;
}
