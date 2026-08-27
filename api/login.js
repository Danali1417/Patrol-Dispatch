// Verifies a login name + password against the hashed accounts stored in
// Supabase and, on success, issues a signed session token. This is the
// only place a password is ever checked — the client sends it once here
// and never receives a stored password or hash back.

import { verifyPassword, issueSessionToken, hashPassword, claimActiveSession } from "./_lib/auth.js";
import { kvGet, kvSet } from "./_lib/supabase.js";
import { DEFAULT_ACCOUNTS } from "./_lib/defaultAccounts.js";

const ACCOUNTS_KEY = "ops:accounts";

async function loadOrSeedAccounts() {
  const raw = await kvGet(ACCOUNTS_KEY);
  let accounts = raw ? JSON.parse(raw) : [];
  if (accounts.length === 0) {
    accounts = await Promise.all(
      DEFAULT_ACCOUNTS.map(async (a) => {
        const { password, ...rest } = a;
        return { ...rest, passwordHash: await hashPassword(password) };
      })
    );
    await kvSet(ACCOUNTS_KEY, JSON.stringify(accounts));
  }
  return accounts;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { loginName, password, role } = req.body || {};
  if (!loginName || !password || !role) {
    return res.status(400).json({ error: "Login name, password, and role are required." });
  }

  try {
    const accounts = await loadOrSeedAccounts();
    const account = accounts.find(
      (a) => a.role === role && a.loginName.toLowerCase() === String(loginName).trim().toLowerCase()
    );
    if (!account) {
      return res.status(401).json({ error: `No ${role} login named "${loginName}" was found.` });
    }
    // Accounts migrated by api/migrate-passwords.js have passwordHash; a
    // never-migrated legacy record would still have a plain `password` —
    // that path is only ever hit if the one-time migration wasn't run yet.
    const ok = account.passwordHash
      ? await verifyPassword(password, account.passwordHash)
      : account.password === password;
    if (!ok) {
      return res.status(401).json({ error: "Password doesn't match that login name." });
    }
    if (account.active === false) {
      return res.status(403).json({ error: "This login has been deactivated. See your manager." });
    }

    // Claiming a fresh session id here invalidates any token already out
    // there for this same account — the point being one login, one window.
    const sid = await claimActiveSession(account);
    const token = issueSessionToken(account, sid);
    const { password: _pw, passwordHash: _hash, ...safeAccount } = account;
    return res.status(200).json({ token, account: safeAccount });
  } catch (err) {
    console.error("login failed:", err);
    return res.status(500).json({ error: "Sign-in is temporarily unavailable — try again shortly." });
  }
}
