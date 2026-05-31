// Inngest wrapper for briefing.
import { inngest } from "@/lib/inngest/client";
import { runBriefing } from "@/lib/jobs/briefing";
import { startCronLog, completeCronLog, failCronLog } from "@/lib/cron-helpers";

export const briefingJob = inngest.createFunction(
  { id: "briefing", triggers: [{ cron: "TZ=America/Vancouver 0 7 * * *" }], concurrency: { limit: 1 }, retries: 2 },
  async ({ step }) => {
    const logId = await step.run("start-log", () => startCronLog("briefing"));
    try {
      const result = await step.run("run", () => runBriefing());
      await step.run("complete-log", () => completeCronLog(logId, result));
      return result;
    } catch (err) {
      await step.run("fail-log", () => failCronLog(logId, String(err)));
      throw err;
    }
  },
);
