// Seed accounts used only to bootstrap a brand-new, empty database (see
// api/accounts.js). Lives server-side now, not in the client bundle —
// these plaintext passwords are hashed at the moment they're written to
// Supabase and never sent to the browser as-is.
export const DEFAULT_ACCOUNTS = [
  { loginName: "Manager1", password: "manager123", role: "manager", displayName: "Duty Manager", active: true },
  { loginName: "ControlRoom1", password: "ops123", role: "operator", displayName: "Control Room 1", active: true },
  { loginName: "ControlRoom2", password: "ops123", role: "operator", displayName: "Control Room 2", active: true },
  { loginName: "T13", password: "patrol123", role: "patrolman", displayName: "T13", shift: "1800–0700", run: "Unassigned", active: true },
  { loginName: "T15", password: "patrol123", role: "patrolman", displayName: "T15", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T22", password: "patrol123", role: "patrolman", displayName: "T22", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T33", password: "patrol123", role: "patrolman", displayName: "T33", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T44", password: "patrol123", role: "patrolman", displayName: "T44", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T55", password: "patrol123", role: "patrolman", displayName: "T55", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T66", password: "patrol123", role: "patrolman", displayName: "T66", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T77", password: "patrol123", role: "patrolman", displayName: "T77", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T88", password: "patrol123", role: "patrolman", displayName: "T88", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T99", password: "patrol123", role: "patrolman", displayName: "T99", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "PST33", password: "patrol123", role: "patrolman", displayName: "PST33", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T77 Day", password: "patrol123", role: "patrolman", displayName: "T77 Day", shift: "0600–1700", run: "Unassigned", active: true },
  { loginName: "T88 Day", password: "patrol123", role: "patrolman", displayName: "T88 Day", shift: "0600–1700", run: "Unassigned", active: true },
  { loginName: "T99 Day", password: "patrol123", role: "patrolman", displayName: "T99 Day", shift: "0600–1700", run: "Unassigned", active: true },
  { loginName: "T55 Day", password: "patrol123", role: "patrolman", displayName: "T55 Day", shift: "0600–1600", run: "Unassigned", active: true },
  { loginName: "T22 Day", password: "patrol123", role: "patrolman", displayName: "T22 Day", shift: "0600–1700", run: "Unassigned", active: true },
];
