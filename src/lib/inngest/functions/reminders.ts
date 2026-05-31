// Inngest wrapper for reminders. Runs hourly; job enforces calling hours.
import { inngest } from "@/lib/inngest/client";
import { runReminders } from "@/lib/jobs/reminders";
import { startCronLog, completeCronLog, failCronLog } from "@/lib/cron-helpers";

export const remindersJob = inngest.createFunction(
  { id: "reminders", triggers: [{ cron: "0 * * * *" }], concurrency: { limit: 1 }, retries: 2 },
  async ({ step }) => {
    const logId = await step.run("start-log", () => startCronLog("reminders"));
    try {
      const result = await step.run("run", () => runReminders());
      await step.run("complete-log", () => completeCronLog(logId, result));
      return result;
    } catch (err) {
      await step.run("fail-log", () => failCronLog(logId, String(err)));
      throw err;
    }
  },
);
