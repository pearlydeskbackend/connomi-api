import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const dynamic = "force-dynamic"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  { auth: { persistSession: false } }
)

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body    = await req.json() as Record<string, unknown>
    const message = body?.message as Record<string, unknown> | undefined

    // Vapi fires status-update with status="in-progress" when call starts
    if (message?.type !== "status-update") {
      return NextResponse.json({ received: true })
    }

    const status = message.status as string
    const call   = message.call as Record<string, unknown> | undefined

    if (!call) return NextResponse.json({ received: true })

    const callId       = call.id as string
    const phoneObj     = call.phoneNumber as Record<string, unknown> | undefined
    const toNumber     = phoneObj?.number as string | null ?? null
    const customerPhone = (call.customer as Record<string, unknown>)?.number as string ?? ""
    const metadata     = call.metadata as Record<string, string> | undefined
    const clinicId     = metadata?.clinic_id ?? null

    // Resolve clinic from phone number if no metadata
    let resolvedClinicId = clinicId
    if (!resolvedClinicId && toNumber) {
      const { data } = await supabase
        .from("clinics")
        .select("id")
        .eq("twilio_phone", toNumber)
        .single()
      resolvedClinicId = data?.id ?? null
    }

    if (!resolvedClinicId) {
      return NextResponse.json({ received: true })
    }

    if (status === "in-progress") {
      // Upsert active call record — dashboard realtime picks this up instantly
      await supabase.from("active_calls").upsert({
        call_id:    callId,
        clinic_id:  resolvedClinicId,
        phone:      customerPhone || null,
        started_at: new Date().toISOString(),
        status:     "active",
      }, { onConflict: "call_id" })

      console.log(`[call-started] Active call upserted: ${callId} clinic: ${resolvedClinicId}`)
    }

    if (status === "ended") {
      // Mark call as ended — clears the active indicator on dashboard
      await supabase
        .from("active_calls")
        .update({ status: "ended", ended_at: new Date().toISOString() })
        .eq("call_id", callId)

      console.log(`[call-ended] Active call closed: ${callId}`)
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error("[vapi/call-started]", err)
    return NextResponse.json({ received: true })
  }
}