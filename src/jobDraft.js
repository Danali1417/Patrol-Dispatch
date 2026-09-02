// Keeps a patrolman's in-progress outcome text, docket number, and
// captured-but-not-yet-submitted photos safe in the browser's own
// localStorage — not the server — so a dropped connection, a backgrounded
// tab getting killed by the OS, or just navigating away from the job never
// costs them the work: reopening the same job restores exactly where they
// left off. Cleared only once the job is confirmed submitted (or found
// already submitted/cancelled by the server), never on a failure — a
// draft that can't be cleared yet is exactly the point.

const DRAFT_PREFIX = "patrol_draft_";

export function loadJobDraft(jobId) {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + jobId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function saveJobDraft(jobId, draft) {
  try {
    localStorage.setItem(DRAFT_PREFIX + jobId, JSON.stringify(draft));
  } catch (e) {
    // Best-effort — e.g. storage full or unavailable in private browsing.
    // The in-memory form state still works for this session; only the
    // "survives a reload" guarantee is what's lost here.
  }
}

export function clearJobDraft(jobId) {
  try {
    localStorage.removeItem(DRAFT_PREFIX + jobId);
  } catch (e) { /* ignore */ }
}
