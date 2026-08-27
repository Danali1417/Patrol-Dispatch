// Password hashing + session tokens for the server-side login system.
// Nothing in this file ever runs in the browser — passwords and the
// signing secret never leave the serverless function.

import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { kvGet, kvSet } from "./supabase.js";

const SESSION_EXPIRY = process.env.SESSION_EXPIRY_HOURS ? `${process.env.SESSION_EXPIRY_HOURS}h` : "24h";

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

// One account signed in on a second device/browser should knock the first
// one out, so the same login can't run on multiple windows at once. Each
// login writes a fresh random id here, keyed by role+loginName (an account
// is uniquely identified by that pair, not loginName alone); a token whose
// embedded `sid` no longer matches this stored value belongs to a session
// that's been superseded by a newer login.
function activeSessionKey(role, loginName) {
  return `ops:activesession:${role}:${String(loginName).trim().toLowerCase()}`;
}

export async function claimActiveSession(account) {
  const sid = crypto.randomUUID();
  await kvSet(activeSessionKey(account.role, account.loginName), sid);
  return sid;
}

// Everything here except the signature is plainly readable by anyone who
// has the token (JWTs are signed, not encrypted) — never put a password
// or hash in the payload.
export function issueSessionToken(account, sid) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured on the server");
  const payload = {
    loginName: account.loginName,
    role: account.role,
    displayName: account.displayName,
    run: account.run,
    shift: account.shift,
    contactNumber: account.contactNumber,
    active: account.active,
    sid,
  };
  return jwt.sign(payload, secret, { expiresIn: SESSION_EXPIRY });
}

// Checks the request's token and, separately, why it might be rejected:
// "superseded" only when the token is otherwise valid but a newer login
// for the same account has since claimed a different session id — every
// other case (missing, malformed, expired, or issued before this feature
// existed) is just a plain expired/no session.
async function resolveSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return { session: null, reason: "expired" };
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return { session: null, reason: "expired" };
  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch (e) {
    return { session: null, reason: "expired" };
  }
  if (!payload.sid) return { session: null, reason: "expired" };
  const currentSid = await kvGet(activeSessionKey(payload.role, payload.loginName));
  if (currentSid !== payload.sid) return { session: null, reason: "superseded" };
  return { session: payload, reason: null };
}

// Returns the decoded session payload, or null if the request has no
// valid, unexpired token, or if a newer login elsewhere has superseded it.
export async function getSession(req) {
  const { session } = await resolveSession(req);
  return session;
}

export async function requireSession(req, res) {
  const { session, reason } = await resolveSession(req);
  if (!session) {
    const message = reason === "superseded"
      ? "Signed out — this account was signed in on another device or browser."
      : "Unauthorized — please sign in again.";
    res.status(401).json({ error: message, reason });
    return null;
  }
  return session;
}

export async function requireRole(req, res, roles) {
  const session = await requireSession(req, res);
  if (!session) return null;
  if (!roles.includes(session.role)) {
    res.status(403).json({ error: "You don't have permission to do that." });
    return null;
  }
  return session;
}
