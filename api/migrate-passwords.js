// One-time migration: hashes any plaintext passwords left over from
// before this app had real authentication. Safe to run more than once —
// accounts that already have a passwordHash and no plaintext password
// are left untouched. Gated by MIGRATE_SECRET rather than a session
// token, since the whole point is to run this before anyone can log in
// under the new system.

import { hashPassword } from "./_lib/auth.js";
import { kvGet, kvSet } from "./_lib/supabase.js";

const ACCOUNTS_KEY = "ops:accounts";

export default async function handler(req, res) {
  const secret = process.env.MIGRATE_SECRET;
  const provided = req.headers["x-migrate-secret"] || req.query?.secret;
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: secret ? "Unauthorized" : "MIGRATE_SECRET is not configured on the server" });
  }

  try {
    const raw = await kvGet(ACCOUNTS_KEY);
    const accounts = raw ? JSON.parse(raw) : [];
    let migrated = 0;
    let alreadyHashed = 0;
    const next = await Promise.all(
      accounts.map(async (a) => {
        if (a.password && !a.passwordHash) {
          migrated++;
          const { password, ...rest } = a;
          return { ...rest, passwordHash: await hashPassword(password) };
        }
        alreadyHashed++;
        return a;
      })
    );
    await kvSet(ACCOUNTS_KEY, JSON.stringify(next));
    return res.status(200).json({ total: accounts.length, migrated, alreadyHashed });
  } catch (err) {
    console.error("migrate-passwords failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
