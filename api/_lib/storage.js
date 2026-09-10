// Supabase Storage access for full-resolution attendance photo originals.
// Everything else in this app (api/_lib/supabase.js) lives in a single
// Postgres text column (kv_store) — fine for job records and even the
// compressed 480px photo previews (60-130KB each, see App.jsx), but never
// meant to hold multi-megabyte camera originals. Storage is Supabase's
// actual object store, built for that.
//
// Originals are private (never a public bucket) and only ever reached
// through a short-lived signed URL minted on demand — same trust model as
// everything else here (session-gated), and it means a leaked/cached link
// stops working on its own instead of staying valid forever.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "attendance-originals";

async function storageFetch(path, opts = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY environment variables");
  }
  const res = await fetch(`${SUPABASE_URL}/storage/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  return res;
}

// Created lazily on first real use rather than requiring a manual setup
// step in the Supabase dashboard — idempotent, since Supabase rejects a
// second create for the same name and that response is just swallowed.
let bucketReady = null;
function ensureBucket() {
  if (!bucketReady) {
    bucketReady = storageFetch("bucket", {
      method: "POST",
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
    }).then((res) => {
      if (!res.ok && res.status !== 400 && res.status !== 409) {
        bucketReady = null; // let a real failure (bad creds, network) retry on the next call
        throw new Error(`Couldn't create Storage bucket (${res.status})`);
      }
    });
  }
  return bucketReady;
}

// Returns a short-lived URL the browser can PUT the original photo bytes
// to directly, bypassing this app's own Vercel functions entirely — a
// typical phone photo is well past what those functions accept in a
// single request (see MAX_ATTENDANCE_PHOTOS's comment in App.jsx).
export async function createUploadUrl(path) {
  await ensureBucket();
  const res = await storageFetch(`object/upload/sign/${BUCKET}/${path}`, { method: "POST", body: JSON.stringify({}) });
  if (!res.ok) throw new Error(`Couldn't create an upload URL (${res.status})`);
  const { signedUrl, path: storedPath } = await res.json();
  const uploadUrl = signedUrl.startsWith("http") ? signedUrl : `${SUPABASE_URL}/storage/v1${signedUrl}`;
  return { uploadUrl, path: storedPath || path };
}

// A fresh, short-lived link to view/download one original. Deliberately
// never stored — a signed link saved once would eventually go stale, so
// only the small `path` returned by createUploadUrl is kept on the photo
// record (see App.jsx), and this is called again each time someone
// actually wants to look at it.
export async function createReadUrl(path, expiresIn = 3600) {
  const res = await storageFetch(`object/sign/${BUCKET}/${path}`, { method: "POST", body: JSON.stringify({ expiresIn }) });
  if (!res.ok) throw new Error(`Couldn't create a read URL (${res.status})`);
  const { signedUrl } = await res.json();
  return signedUrl.startsWith("http") ? signedUrl : `${SUPABASE_URL}/storage/v1${signedUrl}`;
}

// Deletes every original filed under a job's own folder (`${jobId}/...`)
// — called once that job's compressed backup has already gone out (see
// backupAndDeletePhotos in jobArchive.js), same lifecycle as the
// compressed copies it backs up. Storage's remove() takes exact object
// paths rather than a prefix pattern, so this lists the folder first.
export async function deleteAllUnderPrefix(prefix) {
  const listRes = await storageFetch(`object/list/${BUCKET}`, { method: "POST", body: JSON.stringify({ prefix, limit: 100 }) });
  if (!listRes.ok) return; // nothing to clean up, or bucket/prefix never existed — not worth failing the caller over
  const items = await listRes.json().catch(() => []);
  if (!Array.isArray(items) || items.length === 0) return;
  await storageFetch(`object/${BUCKET}`, {
    method: "DELETE",
    body: JSON.stringify({ prefixes: items.map((item) => `${prefix}/${item.name}`) }),
  });
}
