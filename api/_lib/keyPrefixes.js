// Plain key-prefix constants shared between api/kv.js and
// api/_lib/jobArchive.js. Kept in their own file with zero dependencies
// on purpose: api/kv.js used to import these from jobArchive.js directly,
// which pulled in that module's entire dependency chain (nodemailer, via
// mail.js) on every single invocation — including the board's
// every-8-second poll, the overwhelming majority of which never touch
// mail or the archive at all. That extra module-load cost, paid by every
// poll tick from every signed-in device all day, was a real contributor
// to hitting Vercel's Fluid Active CPU allowance.
export const JOB_ARCHIVE_PREFIX = "ops:jobarchive:";
export const JOB_PHOTOS_PREFIX = "ops:jobphotos:";
export const JOB_CHAT_PREFIX = "ops:jobchat:";
