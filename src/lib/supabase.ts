import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
)

export type Clinic = {
  id: string
  name: string
  owner_name: string | null
  owner_email: string | null
  owner_phone: string | null
  address: string | null
  city: string | null
  hours: string | null
  dentists: string | null
  services: string | null
  google_review_link: string | null
  plan: string
  active: boolean
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  vapi_assistant_id: string | null
  twilio_phone: string | null
  created_at: string
  updated_at: string
}

export type Booking = {
  id: string
  clinic_id: string
  patient_name: string
  phone: string
  service: string
  date: string
  time: string
  status: string
  is_new_patient: boolean
  booked_by: string
  notes: string
  reminder_sent: string | null
  review_sent: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

export type Patient = {
  id: string
  clinic_id: string
  patient_name: string
  phone: string
  last_cleaning_date: string | null
  recall_called_at: string | null
  recall_attempts: number
  total_visits: number
  notes: string
  created_at: string
  updated_at: string
}

export type WaitlistEntry = {
  id: string
  clinic_id: string
  patient_name: string
  phone: string
  service: string
  preferred_days: string | null
  preferred_times: string | null
  status: string
  call_attempts: number
  added_at: string
  called_at: string | null
}