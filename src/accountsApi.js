// Client for /api/accounts.js. Kept separate from storageShim.js since
// accounts have their own request shapes (create/patch/reset/delete)
// rather than the generic get/set pattern the rest of the app's data
// uses, and because passwords are never part of the account objects this
// returns.

import { getToken, reportUnauthorized } from "./auth.js";

async function accountsFetch(opts = {}) {
  const token = getToken();
  const res = await fetch("/api/accounts", {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    reportUnauthorized(body.reason);
    throw new Error("Session expired — please sign in again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function listAccounts() {
  const data = await accountsFetch({ method: "GET" });
  return data.accounts;
}

export async function createAccount(fields) {
  const data = await accountsFetch({ method: "POST", body: JSON.stringify(fields) });
  return data.account;
}

export async function updateAccount(loginName, role, patch) {
  const data = await accountsFetch({ method: "PATCH", body: JSON.stringify({ loginName, role, patch }) });
  return data.account;
}

export async function resetPassword(loginName, role, newPassword) {
  await accountsFetch({ method: "PATCH", body: JSON.stringify({ action: "resetPassword", loginName, role, newPassword }) });
}

export async function changeOwnPassword(currentPassword, newPassword) {
  await accountsFetch({ method: "PATCH", body: JSON.stringify({ action: "changeOwnPassword", currentPassword, newPassword }) });
}

export async function deleteAccount(loginName, role) {
  await accountsFetch({ method: "DELETE", body: JSON.stringify({ loginName, role }) });
}

export async function bulkUpdateAccounts({ creates = [], updates = [] }) {
  return accountsFetch({ method: "PATCH", body: JSON.stringify({ action: "bulk", creates, updates }) });
}
