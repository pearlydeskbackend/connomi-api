// ============================================================================
// lib/jobs/waitlist-strategy.ts — the SEAMS where waitlist intelligence plugs
// in. Today these are simple, faithful-to-v1 implementations. The future
// "real-grade" engine replaces the BODIES of these functions without touching
// the cascade that calls them — that's the whole point of isolating them here.
//
// FUTURE UPGRADE TARGETS (documented so the contract is clear):
//   scoreCandidates  -> weighted rank: wait time + fit + reliability + LTV
//                       − declines; filter by duration/provider/preferences.
//   selectChannel    -> SMS for non-urgent, call when urgent or after silence.
//   cascadeStrategy  -> exclusive-then-cascade for distant slots, parallel
//                       blast for imminent ones.
// ============================================================================
import type { Enums } from "@/lib/database.types";

export interface QueueCandidate {
  id: string;
  waitlist_id: string | null;
  patient_name: string;
  phone: string;
  service: string | null;
  slot_starts_at: string;
  queue_position: number;
  priority_score: number;
  method: Enums<"queue_method">;
}

// --- SCORING (today: trust the queue_position already computed at enqueue) ---
// Future: re-rank here by the weighted formula. Kept as a pure function so it's
// unit-testable in isolation when the smart version lands.
export function scoreCandidates(candidates: QueueCandidate[]): QueueCandidate[] {
  return [...candidates].sort((a, b) => a.queue_position - b.queue_position);
}

// --- CHANNEL SELECTION (today: honor the method set at enqueue) -------------
// Future: decide SMS vs call from slot urgency + prior contact history.
export function selectChannel(candidate: QueueCandidate): Enums<"queue_method"> {
  return candidate.method;
}

// --- URGENCY (available now for the future cascade strategy) ----------------
// Hours until the slot. The smart cascade will branch on this: small = blast,
// large = exclusive-then-cascade.
export function hoursUntil(slotStartsAt: string): number {
  return (new Date(slotStartsAt).getTime() - Date.now()) / 3_600_000;
}
