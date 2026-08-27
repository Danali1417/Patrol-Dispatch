// All login-account management: listing (sanitized — no password ever
// included), creating, updating profile fields, resetting a password
// (Manager, no current-password needed), changing your own password
// (any role, requires the current password), and deleting.

import { getSession, requireSession, requireRole, hashPassword, verifyPassword } from "./_lib/auth.js";
import { kvGet, kvSet } from "./_lib/supabase.js";
import { DEFAULT_ACCOUNTS } from "./_lib/defaultAccounts.js";

const ACCOUNTS_KEY = "ops:accounts";

function sanitize(account) {
  const { password, passwordHash, ...safe } = account;
  return safe;
}

async function loadAccounts() {
  const raw = await kvGet(ACCOUNTS_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveAccounts(accounts) {
  await kvSet(ACCOUNTS_KEY, JSON.stringify(accounts));
}

function findIndex(accounts, loginName, role) {
  return accounts.findIndex((a) => a.loginName === loginName && a.role === role);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const session = await requireSession(req, res);
    if (!session) return;
    try {
      let accounts = await loadAccounts();
      if (accounts.length === 0) {
        accounts = await Promise.all(
          DEFAULT_ACCOUNTS.map(async (a) => {
            const { password, ...rest } = a;
            return { ...rest, passwordHash: await hashPassword(password) };
          })
        );
        await saveAccounts(accounts);
      }
      return res.status(200).json({ accounts: accounts.map(sanitize) });
    } catch (err) {
      console.error("accounts GET failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  if (req.method === "POST") {
    const session = await requireRole(req, res, ["manager"]);
    if (!session) return;
    const { loginName, password, role, displayName, shift, run, contactNumber } = req.body || {};
    if (!loginName || !password || !role) {
      return res.status(400).json({ error: "Login name, password, and role are required." });
    }
    try {
      const accounts = await loadAccounts();
      if (accounts.some((a) => a.loginName.toLowerCase() === String(loginName).trim().toLowerCase())) {
        return res.status(409).json({ error: "That login name is already in use — pick a unique one." });
      }
      const acct = {
        loginName: String(loginName).trim(),
        passwordHash: await hashPassword(password),
        role,
        displayName: (displayName || "").trim() || String(loginName).trim(),
        active: true,
        contactNumber: (contactNumber || "").trim(),
      };
      if (role === "patrolman") {
        acct.shift = (shift || "").trim();
        acct.run = run || "Unassigned";
      }
      accounts.push(acct);
      await saveAccounts(accounts);
      return res.status(200).json({ account: sanitize(acct) });
    } catch (err) {
      console.error("accounts POST failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  if (req.method === "PATCH") {
    const { action } = req.body || {};

    if (action === "changeOwnPassword") {
      const session = await requireSession(req, res);
      if (!session) return;
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: "Current password and a new password (min 4 characters) are required." });
      }
      try {
        const accounts = await loadAccounts();
        const idx = findIndex(accounts, session.loginName, session.role);
        if (idx === -1) return res.status(404).json({ error: "Account not found." });
        const ok = await verifyPassword(currentPassword, accounts[idx].passwordHash);
        if (!ok) return res.status(401).json({ error: "Current password is incorrect." });
        accounts[idx] = { ...accounts[idx], passwordHash: await hashPassword(newPassword) };
        delete accounts[idx].password;
        await saveAccounts(accounts);
        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error("changeOwnPassword failed:", err);
        return res.status(500).json({ error: String(err?.message || err) });
      }
    }

    if (action === "resetPassword") {
      const session = await requireRole(req, res, ["manager"]);
      if (!session) return;
      const { loginName, role, newPassword } = req.body || {};
      if (!loginName || !role || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: "loginName, role, and a new password (min 4 characters) are required." });
      }
      try {
        const accounts = await loadAccounts();
        const idx = findIndex(accounts, loginName, role);
        if (idx === -1) return res.status(404).json({ error: "Account not found." });
        accounts[idx] = { ...accounts[idx], passwordHash: await hashPassword(newPassword) };
        delete accounts[idx].password;
        await saveAccounts(accounts);
        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error("resetPassword failed:", err);
        return res.status(500).json({ error: String(err?.message || err) });
      }
    }

    if (action === "bulk") {
      // Bulk create/update in one read-modify-write — used by the Excel
      // roster import and by run rename/delete cascades that can touch
      // many patrolman accounts at once.
      const session = await requireRole(req, res, ["manager", "operator"]);
      if (!session) return;
      const { creates = [], updates = [] } = req.body || {};
      const allowed = ["run", "contactNumber", "active", "displayName", "shift"];
      try {
        const accounts = await loadAccounts();
        for (const u of updates) {
          const idx = findIndex(accounts, u.loginName, u.role);
          if (idx === -1) continue;
          const safePatch = {};
          for (const k of allowed) if (u.patch && k in u.patch) safePatch[k] = u.patch[k];
          accounts[idx] = { ...accounts[idx], ...safePatch };
        }
        for (const c of creates) {
          if (!c.loginName || !c.password || !c.role) continue;
          if (accounts.some((a) => a.loginName.toLowerCase() === c.loginName.toLowerCase())) continue;
          accounts.push({
            loginName: c.loginName,
            passwordHash: await hashPassword(c.password),
            role: c.role,
            displayName: c.displayName || c.loginName,
            active: true,
            contactNumber: c.contactNumber || "",
            ...(c.role === "patrolman" ? { shift: c.shift || "", run: c.run || "Unassigned" } : {}),
          });
        }
        await saveAccounts(accounts);
        return res.status(200).json({ ok: true, updated: updates.length, created: creates.length });
      } catch (err) {
        console.error("accounts bulk PATCH failed:", err);
        return res.status(500).json({ error: String(err?.message || err) });
      }
    }

    // Default: profile field update (run, contactNumber, active, displayName, shift)
    const session = await requireRole(req, res, ["manager"]);
    if (!session) return;
    const { loginName, role, patch } = req.body || {};
    if (!loginName || !role || !patch || typeof patch !== "object") {
      return res.status(400).json({ error: "loginName, role, and patch are required." });
    }
    const allowed = ["run", "contactNumber", "active", "displayName", "shift"];
    const safePatch = {};
    for (const k of allowed) if (k in patch) safePatch[k] = patch[k];
    try {
      const accounts = await loadAccounts();
      const idx = findIndex(accounts, loginName, role);
      if (idx === -1) return res.status(404).json({ error: "Account not found." });
      accounts[idx] = { ...accounts[idx], ...safePatch };
      await saveAccounts(accounts);
      return res.status(200).json({ account: sanitize(accounts[idx]) });
    } catch (err) {
      console.error("accounts PATCH failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  if (req.method === "DELETE") {
    const session = await requireRole(req, res, ["manager"]);
    if (!session) return;
    const { loginName, role } = req.body || {};
    if (!loginName || !role) return res.status(400).json({ error: "loginName and role are required." });
    if (loginName === session.loginName && role === session.role) {
      return res.status(400).json({ error: "You can't delete the login you're currently signed in with." });
    }
    try {
      const accounts = await loadAccounts();
      const next = accounts.filter((a) => !(a.loginName === loginName && a.role === role));
      await saveAccounts(next);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("accounts DELETE failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
