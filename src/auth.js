// Client-side session handling: stores the signed token from /api/login,
// decodes its (unencrypted but signed) payload to restore the session on
// page load, and lets storageShim.js report a 401 back up to the app so
// it can force a clean sign-out.

const TOKEN_KEY = "patrol_session_token";
let onUnauthorized = null;

export function setOnUnauthorized(cb) {
  onUnauthorized = cb;
}

// `reason` is the server's classification of why the token stopped working:
// "superseded" (this account logged in on another device/browser) vs.
// anything else (plain expiry) — lets the sign-in screen explain which.
export function reportUnauthorized(reason) {
  clearToken();
  if (onUnauthorized) onUnauthorized(reason);
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (e) {
    return null;
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch (e) { /* storage unavailable — session just won't persist across reloads */ }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* ignore */ }
}

function decodeJwtPayload(token) {
  try {
    const base64url = token.split(".")[1];
    const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch (e) {
    return null;
  }
}

// Returns the session (same shape the app already uses: loginName, role,
// displayName, run, shift, contactNumber, active) restored from a stored
// token, or null if there isn't one / it's expired.
export function restoreSession() {
  const token = getToken();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) { clearToken(); return null; }
  if (payload.exp && Date.now() >= payload.exp * 1000) { clearToken(); return null; }
  return { ...payload, id: payload.loginName };
}

export async function login(loginName, password, role) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginName, password, role }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Sign-in failed (${res.status})`);
  setToken(data.token);
  // Merge in the token's own payload (notably `sid`) so a freshly-logged-in
  // session object matches what restoreSession() produces after a reload —
  // without this, anything keyed on session.sid (e.g. presence tracking)
  // silently wouldn't work until the page was reloaded once.
  const payload = decodeJwtPayload(data.token);
  return { ...data.account, ...(payload || {}), id: data.account.loginName };
}

export function logout() {
  clearToken();
}
