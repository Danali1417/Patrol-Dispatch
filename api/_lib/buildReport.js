import { kvGet } from "./supabase.js";
import { getReportWindow } from "./time.js";
import {
  REPORT_COLUMNS_BRIEF, REPORT_COLUMNS_DETAILED, reportRow, patrolmanRunSummary,
} from "../../src/reportUtils.js";

const JOBS_KEY = "ops:jobs";
const COMPANY_NAME_KEY = "ops:companyName";
const DEFAULT_COMPANY_NAME = "Ausgroup";

// Pulls jobs + company name from Supabase and builds everything the PDFs
// and email body need for the 06:00-to-06:00 shift-day window ending at
// `now` (in `timeZone`). Kept separate from sending/auth so it can be
// exercised in isolation (e.g. with a mocked kvGet) without hitting Gmail.
export async function gatherReportData({ timeZone, now }) {
  const window = getReportWindow(timeZone, now);

  const [jobsRaw, companyNameRaw] = await Promise.all([
    kvGet(JOBS_KEY),
    kvGet(COMPANY_NAME_KEY),
  ]);
  const allJobs = jobsRaw ? JSON.parse(jobsRaw) : [];
  const companyName = companyNameRaw || DEFAULT_COMPANY_NAME;

  const filteredJobs = allJobs.filter((j) => {
    if (!j.dispatchTime) return false;
    return j.dispatchTime >= window.startISO && j.dispatchTime < window.endISO;
  });

  const briefRows = filteredJobs.map((j) => reportRow(j, "brief", timeZone));
  const detailedRows = filteredJobs.map((j) => reportRow(j, "detailed", timeZone));
  const summary = patrolmanRunSummary(filteredJobs);

  return {
    window,
    companyName,
    filteredJobs,
    briefRows,
    detailedRows,
    summary,
    columnsBrief: REPORT_COLUMNS_BRIEF,
    columnsDetailed: REPORT_COLUMNS_DETAILED,
  };
}
