// Inngest wrapper for reengagement.
import { inngest } from "@/lib/inngest/client";
import { runReengagement } from "@/lib/jobs/reengagement";
import { startCronLog, completeCronLog, failCronLog } from "@/lib/cron-helpers";

export const reengagementJob = inngest.createFunction(
  { id: "reengagement", triggers: [{ cron: "0 13 * * 2,4" }], concurrency: { limit: 1 }, retries: 2 },
  async ({ step }) => {
    const logId = await step.run("start-log", () => startCronLog("reengagement"));
    try {
      const result = await step.run("run", () => runReengagement());
      await step.run("complete-log", () => completeCronLog(logId, result));
      return result;
    } catch (err) {
      await step.run("fail-log", () => failCronLog(logId, String(err)));
      throw err;
    }
  },
);
