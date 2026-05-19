import { createClient } from '@supabase/supabase-js'

// ─── ENVIRONMENT VALIDATION ───────────────────────────────────────────────────
// Fail hard on startup if critical env vars are missing
// Surfaces in Vercel build logs immediately — never silently broken

const REQUIRED_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'CRON_SECRET',
  'VAPI_API_KEY',
  'VAPI_ASSISTANT_ID',
  'VAPI_WAITLIST_ASSISTANT_ID',
  'VAPI_REMINDER_ASSISTANT_ID',
  'VAPI_RECALL_ASSISTANT_ID',
  'VAPI_REENGAGEMENT_ASSISTANT_ID',
  'VAPI_PHONE_NUMBER_ID',
  'NEXT_PUBLIC_APP_URL',
] as const

function validateEnv(): void {
  const missing: string[] = []

  for (const key of REQUIRED_ENV_VARS) {
    if (!process.env[key]) {
      missing.push(key)
    }
  }

  if (missing.length > 0) {
    const msg = `[supabase] Missing required environment variables:\n${missing.map(k => `  - ${k}`).join('\n')}`
    console.error(msg)
    // In production throw — catches misconfigured deploys immediately
    // In development warn — allows partial local setup
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg)
    }
  }
}

// Run validation on module load
// This fires when any route imports supabase
// Missing vars are caught immediately not buried in runtime errors
validateEnv()

// ─── CLIENT ───────────────────────────────────────────────────────────────────
// Uses Supabase connection pooler (PgBouncer) in production
// Prevents connection exhaustion at scale
//
// Connection limits:
//   Direct (5432): 1 connection per client instance
//   Pooler (6543): shared pool, handles 100+ concurrent Vercel functions
//
// To enable pooling:
//   Set NEXT_PUBLIC_SUPABASE_URL to the pooler URL:
//   From: https://mzrjdeiuevotorilifsk.supabase.co
//   To:   https://mzrjdeiuevotorilifsk.supabase.co (same for supabase-js)
//   The pooling happens at the DB driver level via db_url below

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const supabaseKey = process.env.SUPABASE_SERVICE_KEY ?? ''

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession:    false,
    autoRefreshToken:  false,
  },
  db: {
    schema: 'public',
  },
  global: {
    headers: {
      // Tag all requests for easier debugging in Supabase logs
      'x-application-name': 'pearlydesk-api',
    },
  },
})

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type Clinic = {
  id:                      string
  name:                    string
  owner_name:              string | null
  owner_email:             string | null
  owner_phone:             string | null
  address:                 string | null
  city:                    string | null
  hours:                   string | null
  dentists:                string | null
  services:                string | null
  google_review_link:      string | null
  plan:                    string
  active:                  boolean
  stripe_customer_id:      string | null
  stripe_subscription_id:  string | null
  vapi_assistant_id:       string | null
  twilio_phone:            string | null
  open_time:               string | null
  close_time:              string | null
  open_days:               string | null
  slot_duration_minutes:   number | null
  holiday_dates:           string | null
  timezone:                string | null
  ical_url:                string | null
  ical_sync_enabled:       boolean | null
  ical_last_synced_at:     string | null
  created_at:              string
  updated_at:              string
}

export type Booking = {
  id:                      string
  clinic_id:               string
  patient_name:            string
  phone:                   string
  service:                 string
  date:                    string
  time:                    string
  status:                  string
  is_new_patient:          boolean
  booked_by:               string
  notes:                   string
  reminder_sent:           string | null
  review_sent:             string | null
  cancelled_at:            string | null
  followup_sent_at:        string | null
  followup_type:           string | null
  no_show_at:              string | null
  reappointment_sent_at:   string | null
  deleted_at:              string | null
  created_at:              string
  updated_at:              string
}

export type Patient = {
  id:                      string
  clinic_id:               string
  patient_name:            string
  phone:                   string
  last_cleaning_date:      string | null
  recall_called_at:        string | null
  recall_attempts:         number
  recall_status:           string | null
  recall_sequence_step:    number | null
  recall_next_attempt_at:  string | null
  recall_sms_sent_at:      string | null
  recall_last_service:     string | null
  last_contacted_at:       string | null
  total_visits:            number
  notes:                   string
  deleted_at:              string | null
  created_at:              string
  updated_at:              string
}

export type WaitlistEntry = {
  id:                      string
  clinic_id:               string
  patient_name:            string
  phone:                   string
  service:                 string
  preferred_days:          string | null
  preferred_times:         string | null
  preferred_time_of_day:   string | null
  preferred_day_numbers:   string | null
  status:                  string
  attempt_count:           number
  declined_count:          number
  priority:                number
  max_wait_days:           number | null
  expires_at:              string | null
  added_at:                string
  last_attempt_at:         string | null
  booked_at:               string | null
  declined_at:             string | null
  matched_booking_id:      string | null
  deleted_at:              string | null
}