// Authenticated proxy for the app's general-purpose data (jobs, sites,
// zones, roster, logo, company name). Replaces the client's former direct
// access to Supabase — every read and write now requires a valid session,
// except the two keys shown on the sign-in screen before anyone has
// logged in (logo, company name), which are readable by anyone but only
// writable by a Manager.

import { getSession, requireRole } from "./_lib/auth.js";
import { kvGet, kvSet } from "./_lib/supabase.js";

const PUBLIC_READ_KEYS = new Set(["ops:logo", "ops:companyName"]);
const MANAGER_ONLY_WRITE_KEYS = new Set(["ops:logo", "ops:companyName"]);
const OPERATOR_UP_WRITE_KEYS = new Set(["ops:sites", "ops:zones", "ops:roster"]);
const KNOWN_KEYS = new Set(["ops:jobs", "ops:sites", "ops:zones", "ops:roster", "ops:logo", "ops:companyName"]);

export default async function handler(req, res) {
  const key = req.method === "GET" ? req.query?.key : req.body?.key;
  if (!key || !KNOWN_KEYS.has(key)) {
    return res.status(400).json({ error: "Unknown or missing key" });
  }

  if (req.method === "GET") {
    if (!PUBLIC_READ_KEYS.has(key) && !getSession(req)) {
      return res.status(401).json({ error: "Unauthorized — please sign in again." });
    }
    try {
      const value = await kvGet(key);
      if (value === null) return res.status(404).json({ error: "not found" });
      return res.status(200).json({ key, value });
    } catch (err) {
      console.error("kv GET failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  if (req.method === "POST") {
    const roles = MANAGER_ONLY_WRITE_KEYS.has(key)
      ? ["manager"]
      : OPERATOR_UP_WRITE_KEYS.has(key)
      ? ["manager", "operator"]
      : ["manager", "operator", "patrolman"];
    const session = requireRole(req, res, roles);
    if (!session) return; // response already sent

    const { value } = req.body || {};
    if (value === undefined) return res.status(400).json({ error: "value is required" });
    try {
      await kvSet(key, value);
      return res.status(200).json({ key, value });
    } catch (err) {
      console.error("kv POST failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
