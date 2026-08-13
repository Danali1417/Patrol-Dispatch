// Timezone-aware helpers for the daily report cron. Vercel's serverless
// functions run in UTC regardless of where the team is, so every
// "what time is it right now for the team" question has to go through
// these rather than plain `new Date()`.

// UTC offset (in minutes) that `timeZone` is observing at `date` — handles
// daylight saving automatically via the IANA tz database Node ships with.
export function getTimeZoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const map = {};
  parts.forEach((p) => { if (p.type !== "literal") map[p.type] = p.value; });
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    map.hour === "24" ? 0 : Number(map.hour), Number(map.minute), Number(map.second)
  );
  return (asUTC - date.getTime()) / 60000;
}

// The wall-clock date/time components "now" reads as in `timeZone`.
export function getZonedNow(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const map = {};
  parts.forEach((p) => { if (p.type !== "literal") map[p.type] = p.value; });
  return {
    year: Number(map.year), month: Number(map.month), day: Number(map.day),
    hour: map.hour === "24" ? 0 : Number(map.hour), minute: Number(map.minute),
  };
}

// Converts a wall-clock date/time in `timeZone` (e.g. "13 Aug 2026, 06:00
// Australia/Sydney") into the real UTC instant it represents.
export function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const approx = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offsetMin = getTimeZoneOffsetMinutes(approx, timeZone);
  return new Date(approx.getTime() - offsetMin * 60000);
}

function pad2(n) { return String(n).padStart(2, "0"); }

// "DD/MM/YY HHmm" — matches the format the team asked the report window
// to be labelled with, e.g. "12/08/26 0600".
export function fmtWindowLabel(utcDate, timeZone) {
  const p = getZonedNow(timeZone, utcDate);
  return `${pad2(p.day)}/${pad2(p.month)}/${String(p.year).slice(-2)} ${pad2(p.hour)}${pad2(p.minute)}`;
}

// The report's 24-hour "shift day" window: from yesterday's 06:00 to
// today's 06:00, both in `timeZone`, evaluated relative to `now`.
export function getReportWindow(timeZone, now = new Date()) {
  const today = getZonedNow(timeZone, now);
  const endUtc = zonedWallTimeToUtc(today.year, today.month, today.day, 6, 0, timeZone);
  const startUtc = new Date(endUtc.getTime() - 24 * 60 * 60 * 1000);
  return {
    startISO: startUtc.toISOString(),
    endISO: endUtc.toISOString(),
    startLabel: fmtWindowLabel(startUtc, timeZone),
    endLabel: fmtWindowLabel(endUtc, timeZone),
    dateKey: `${today.year}-${pad2(today.month)}-${pad2(today.day)}`,
  };
}
