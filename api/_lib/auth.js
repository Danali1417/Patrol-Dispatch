// Password hashing + session tokens for the server-side login system.
// Nothing in this file ever runs in the browser — passwords and the
// signing secret never leave the serverless function.

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SESSION_EXPIRY = process.env.SESSION_EXPIRY_HOURS ? `${process.env.SESSION_EXPIRY_HOURS}h` : "24h";

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

// Everything here except the signature is plainly readable by anyone who
// has the token (JWTs are signed, not encrypted) — never put a password
// or hash in the payload.
export function issueSessionToken(account) {
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
  };
  return jwt.sign(payload, secret, { expiresIn: SESSION_EXPIRY });
}

// Returns the decoded session payload, or null if the request has no
// valid, unexpired token.
export function getSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, secret);
  } catch (e) {
    return null;
  }
}

export function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "Unauthorized — please sign in again." });
    return null;
  }
  return session;
}

export function requireRole(req, res, roles) {
  const session = requireSession(req, res);
  if (!session) return null;
  if (!roles.includes(session.role)) {
    res.status(403).json({ error: "You don't have permission to do that." });
    return null;
  }
  return session;
}
