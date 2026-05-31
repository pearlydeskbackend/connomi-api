// Inngest wrapper for reviews. Runs a few times daily; job enforces calling hours.
import { inngest } from "@/lib/inngest/client";
import { runReviews } from "@/lib/jobs/reviews";
import { startCronLog, completeCronLog, failCronLog } from "@/lib/cron-helpers";

export const reviewsJob = inngest.createFunction(
  { id: "reviews", triggers: [{ cron: "0 10,14,18 * * *" }], concurrency: { limit: 1 }, retries: 2 },
  async ({ step }) => {
    const logId = await step.run("start-log", () => startCronLog("reviews"));
    try {
      const result = await step.run("run", () => runReviews());
      await step.run("complete-log", () => completeCronLog(logId, result));
      return result;
    } catch (err) {
      await step.run("fail-log", () => failCronLog(logId, String(err)));
      throw err;
    }
  },
);
