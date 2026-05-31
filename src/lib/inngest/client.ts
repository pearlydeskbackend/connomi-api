// ============================================================================
// lib/inngest/client.ts — Inngest v4 client + typed event definitions.
// v4 dropped the centralized EventSchemas class; event types are now defined
// with eventType() and shared between send / waitForEvent / triggers.
//
// HIPAA: the only payload event carries IDs only (clinicId, slotId) — no PHI.
// ============================================================================
import { Inngest, eventType, staticSchema } from "inngest";

export const inngest = new Inngest({ id: "connomi-api" });

// Fan-out event when a slot opens: IDs only, PHI fetched inside the step.
export const slotOpened = eventType("waitlist/slot.opened", {
  schema: staticSchema<{ clinicId: string; slotId: string }>(),
});
