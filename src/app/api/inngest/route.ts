// ============================================================================
// /api/inngest — the serve endpoint. This is what makes the jobs RUN: Inngest
// calls this URL to discover registered functions and to execute each step.
// Every cron wrapper must be listed here, or it silently never fires.
//
// After deploy, register this URL once in the Inngest dashboard (or via the
// Vercel integration): https://<your-domain>/api/inngest
// ============================================================================
import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";

import { recallJob } from "@/lib/inngest/functions/recall";
import { remindersJob } from "@/lib/inngest/functions/reminders";
import { reviewsJob } from "@/lib/inngest/functions/reviews";
import { noShowJob } from "@/lib/inngest/functions/noshow";
import { reengagementJob } from "@/lib/inngest/functions/reengagement";
import { followupJob } from "@/lib/inngest/functions/followup";
import { reappointmentJob } from "@/lib/inngest/functions/reappointment";
import { briefingJob } from "@/lib/inngest/functions/briefing";
import { waitlistCascadeJob } from "@/lib/inngest/functions/waitlist-cascade";
import { waitlistMaintenanceJob } from "@/lib/inngest/functions/waitlist-maintenance";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    recallJob,
    remindersJob,
    reviewsJob,
    noShowJob,
    reengagementJob,
    followupJob,
    reappointmentJob,
    briefingJob,
    waitlistCascadeJob,
    waitlistMaintenanceJob,
  ],
});
