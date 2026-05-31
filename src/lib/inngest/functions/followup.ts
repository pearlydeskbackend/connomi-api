// Inngest wrapper for followup.
import { inngest } from "@/lib/inngest/client";
import { runFollowup } from "@/lib/jobs/followup";
import { startCronLog, completeCronLog, failCronLog } from "@/lib/cron-helpers";

export const followupJob = inngest.createFunction(
  { id: "followup", triggers: [{ cron: "0 15 * * *" }], concurrency: { limit: 1 }, retries: 2 },
  async ({ step }) => {
    const logId = await step.run("start-log", () => startCronLog("followup"));
    try {
      const result = await step.run("run", () => runFollowup());
      await step.run("complete-log", () => completeCronLog(logId, result));
      return result;
    } catch (err) {
      await step.run("fail-log", () => failCronLog(logId, String(err)));
      throw err;
    }
  },
);
