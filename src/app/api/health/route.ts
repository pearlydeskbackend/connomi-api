import { NextResponse } from 'next/server'

export async function GET() {
  const checks = {
    NEXT_PUBLIC_SUPABASE_URL:    !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_KEY:        !!process.env.SUPABASE_SERVICE_KEY,
    TWILIO_ACCOUNT_SID:         !!process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN:          !!process.env.TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER:        !!process.env.TWILIO_PHONE_NUMBER,
    VAPI_API_KEY:               !!process.env.VAPI_API_KEY,
    VAPI_PHONE_NUMBER_ID:       !!process.env.VAPI_PHONE_NUMBER_ID,
    VAPI_TEMPLATE_ASSISTANT_ID: !!process.env.VAPI_TEMPLATE_ASSISTANT_ID,
    CRON_SECRET:                !!process.env.CRON_SECRET,
    ADMIN_SECRET:               !!process.env.ADMIN_SECRET,
  }

  const missing = Object.entries(checks)
    .filter(([, isSet]) => !isSet)
    .map(([key]) => key)

  return NextResponse.json(
    { status: missing.length === 0 ? 'ok' : 'missing_config', missing, checks },
    { status: missing.length === 0 ? 200 : 500 }
  )
}