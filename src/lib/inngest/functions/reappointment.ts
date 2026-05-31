// Inngest wrapper for reappointment.
import { inngest } from "@/lib/inngest/client";
import { runReappointment } from "@/lib/jobs/reappointment";
import { startCronLog, completeCronLog, failCronLog } from "@/lib/cron-helpers";

export const reappointmentJob = inngest.createFunction(
  { id: "reappointment", triggers: [{ cron: "0 10 * * *" }], concurrency: { limit: 1 }, retries: 2 },
  async ({ step }) => {
    const logId = await step.run("start-log", () => startCronLog("reappointment"));
    try {
      const result = await step.run("run", () => runReappointment());
      await step.run("complete-log", () => completeCronLog(logId, result));
      return result;
    } catch (err) {
      await step.run("fail-log", () => failCronLog(logId, String(err)));
      throw err;
    }
  },
);
