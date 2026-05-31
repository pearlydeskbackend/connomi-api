# Connomi AI — API v2 Install & Deployment Guide

The full v2 backend: Vapi voice routes, the durable cron/revenue engine
(Inngest), inbound SMS, onboarding, and health. Everything is type-checked as
one unit. Since nothing is live yet, you install the whole thing at once.

---

## Step 1 — Database (Supabase)

Create a fresh Supabase project, then run these SQL files **in order** in the
SQL Editor:

1. `connomi_schema_v2_complete.sql` — schema, enums, views, RLS, functions
2. `connomi_availability_engine.sql` — `get_available_slots`
3. `connomi_booking_write.sql` — `book_appointment` (+ exclusion constraint)
4. `migrations/003_clinic_agent_name.sql` — per-clinic `agent_name`

Then regenerate the types from your live schema (recommended — makes them
canonical):

```bash
npx supabase gen types typescript --project-id <id> > src/lib/database.types.ts
```

(The hand-written `database.types.ts` in this package is accurate to the schema
above and works as-is if you skip this.)

## Step 2 — Code

Unzip this package's `src/` into your `connomi-api` project, replacing the old
`src/`. Then:

```bash
npm install
npm install inngest @supabase/supabase-js zod
npm run build
```

## Step 3 — Environment (`.env.local`)

The config layer validates these at boot and fails loudly if any required one
is missing. **Note the renamed key**: `SUPABASE_SERVICE_ROLE_KEY` (was
`SUPABASE_SERVICE_KEY` in v1).

Required:
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
VAPI_API_KEY=
```

Optional / feature-specific:
```
VAPI_WEBHOOK_SECRET=            # set in production to verify Vapi webhooks
VAPI_PHONE_NUMBER_ID=           # outbound calls (recall, waitlist, etc.)
VAPI_RECALL_ASSISTANT_ID=
VAPI_REMINDER_ASSISTANT_ID=
VAPI_REENGAGEMENT_ASSISTANT_ID=
VAPI_WAITLIST_ASSISTANT_ID=
VAPI_TEMPLATE_ASSISTANT_ID=     # onboarding clones this per clinic
CRON_SECRET=                    # internal route auth (fill-slot)
ADMIN_SECRET=                   # onboarding/provision auth
DASHBOARD_URL=https://app.connomi.com
BILLING_URL=https://connomi.com/billing
```

## Step 4 — Inngest (the cron/revenue engine)

The jobs only run once Inngest knows about the serve endpoint:

1. Create an Inngest account; **sign the BAA** (patient data — see HIPAA note).
2. Add `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` from the dashboard to env.
3. Deploy, then register `https://<your-domain>/api/inngest` in Inngest (or use
   the Vercel integration, which auto-registers).
4. Verify all 10 functions appear in the Inngest dashboard.

## Step 5 — Wire the webhooks

- **Vapi**: point assistant tool calls + the server/end-of-call webhook at
  `https://<domain>/api/vapi/<tool>` and `/api/vapi/end-of-call`.
- **Twilio**: set the inbound SMS webhook to `https://<domain>/api/twilio/webhook`.

## Step 6 — Verify

- `GET /api/health` → `{ status: "ok", db: "ok" }`
- Onboard a test clinic via `POST /api/onboarding/provision` (with
  `x-admin-secret`).
- Place a test call → confirm a booking lands in `bookings` linked to a
  `patients` row.
- Check the Inngest dashboard shows scheduled runs.

---

## What's included

**Voice (Sophie):** book, availability, cancel, reschedule, confirm, message,
waitlist, waitlist-outcome, send-review, end-of-call.

**Revenue engine (Inngest, durable):** recall (multi-step), reminders
(+ high-value voice), reviews (complaint-suppressed), no-show recovery,
12-month reengagement, post-visit follow-up, reappointment, morning briefing,
waitlist cascade (with pluggable scoring/channel seams), waitlist maintenance.

**Infra:** inbound SMS commands, clinic onboarding, internal slot-fill, health.

## HIPAA notes

- Inngest events carry **IDs only**; PHI is fetched inside steps from Supabase.
  Sign BAAs with Supabase, Vapi, Twilio, and Inngest.
- The service-role key bypasses RLS — server-only, never in the client bundle.
- RLS is enforced on every table via `get_clinic_id()`.

## Not yet included (intentional follow-ons)

- `internal/sync-calendar` (iCal/PMS busy-time sync) — self-contained; build
  when you wire real PMS integration.
- **Real-grade waitlist intelligence** — the cascade has clean seams
  (`scoreCandidates`, `selectChannel` in `lib/jobs/waitlist-strategy.ts`); the
  weighted scoring + tiered cascade engine drops into those bodies. Deserves
  its own SQL-tested build.

## Honest testing status

The **SQL** (schema, availability, booking) was executed and tested on real
Postgres. The **TypeScript** is verified to compile cleanly against the real
Next.js / Supabase / Zod / Inngest types — type-checked, not runtime-tested
against your live services. First thing to test end-to-end after deploy: the
booking path with a real call.
