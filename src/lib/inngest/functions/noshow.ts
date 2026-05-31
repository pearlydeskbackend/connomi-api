// Inngest wrapper for no-show detection. Runs each morning; job enforces hours.
import { inngest } from "@/lib/inngest/client";
import { runNoShow } from "@/lib/jobs/noshow";
import { startCronLog, completeCronLog, failCronLog } from "@/lib/cron-helpers";

export const noShowJob = inngest.createFunction(
  { id: "noshow", triggers: [{ cron: "0 11 * * *" }], concurrency: { limit: 1 }, retries: 2 },
  async ({ step }) => {
    const logId = await step.run("start-log", () => startCronLog("noshow"));
    try {
      const result = await step.run("run", () => runNoShow());
      await step.run("complete-log", () => completeCronLog(logId, result));
      return result;
    } catch (err) {
      await step.run("fail-log", () => failCronLog(logId, String(err)));
      throw err;
    }
  },
);
