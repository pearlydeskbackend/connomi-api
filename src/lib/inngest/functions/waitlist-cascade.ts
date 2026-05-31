// Inngest wrapper for the waitlist cascade. Runs every few minutes to work
// the queue promptly (a freed slot is a decaying asset).
import { inngest } from "@/lib/inngest/client";
import { runWaitlistCascade } from "@/lib/jobs/waitlist-cascade";
import { startCronLog, completeCronLog, failCronLog } from "@/lib/cron-helpers";

export const waitlistCascadeJob = inngest.createFunction(
  { id: "waitlist-cascade", triggers: [{ cron: "*/3 * * * *" }], concurrency: { limit: 1 }, retries: 2 },
  async ({ step }) => {
    const logId = await step.run("start-log", () => startCronLog("waitlist-cascade"));
    try {
      const result = await step.run("run", () => runWaitlistCascade());
      await step.run("complete-log", () => completeCronLog(logId, result));
      return result;
    } catch (err) {
      await step.run("fail-log", () => failCronLog(logId, String(err)));
      throw err;
    }
  },
);
