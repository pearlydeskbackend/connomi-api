// ============================================================================
// lib/inngest/functions/recall.ts — Inngest v4 WRAPPER around runRecall().
// Triggers live in the options object (v4). This is the only Inngest-aware
// part; the work is runRecall(), which stays scheduler-agnostic.
// ============================================================================
import { inngest } from "@/lib/inngest/client";
import { runRecall } from "@/lib/jobs/recall";
import { startCronLog, completeCronLog, failCronLog } from "@/lib/cron-helpers";

export const recallJob = inngest.createFunction(
  {
    id: "recall",
    triggers: [{ cron: "*/30 * * * *" }], // every 30 min; job enforces calling hours
    concurrency: { limit: 1 },             // never overlap runs
    retries: 2,
  },
  async ({ step }) => {
    const logId = await step.run("start-log", () => startCronLog("recall"));
    try {
      const result = await step.run("run-recall", () => runRecall());
      await step.run("complete-log", () => completeCronLog(logId, result));
      return result;
    } catch (err) {
      await step.run("fail-log", () => failCronLog(logId, String(err)));
      throw err; // let Inngest retry
    }
  },
);
