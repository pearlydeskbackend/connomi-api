// ============================================================================
// POST /api/onboarding/provision — admin-only clinic onboarding.
// Creates the clinic, clones a Vapi assistant for it, and creates the owner's
// auth user. NOTE: in v2 the handle_new_user DB trigger auto-creates the
// public.users row from the auth user's metadata (clinic_id), so we do NOT
// insert it here — doing so would duplicate. We pass clinic_id in metadata.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { sendSMS, smsWelcome } from "@/lib/twilio";
import { cloneVapiAssistant } from "@/lib/vapi";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as Record<string, string>;
    const { clinicName, ownerName, ownerEmail, ownerPhone, address, city,
            googleReviewLink, stripeCustomerId, stripeSubscriptionId, plan, agentName } = body;

    if (!clinicName || !ownerEmail) {
      return NextResponse.json({ error: "clinicName and ownerEmail required" }, { status: 400 });
    }

    // 1) create the clinic
    const { data: clinic, error: clinicErr } = await db()
      .from("clinics")
      .insert({
        name: clinicName,
        owner_name: ownerName ?? null,
        owner_email: ownerEmail,
        owner_phone: ownerPhone ?? null,
        plan: plan || "starter",
        active: true,
        agent_name: agentName || "Sophie",
      })
      .select("*")
      .single();
    if (clinicErr || !clinic) {
      return NextResponse.json({ error: "Failed to create clinic" }, { status: 500 });
    }

    // optional fields not in the strict Insert type — set in a follow-up update
    await db().from("clinics").update({
      city: city ?? null,
      google_review_link: googleReviewLink ?? null,
      stripe_customer_id: stripeCustomerId ?? null,
      stripe_subscription_id: stripeSubscriptionId ?? null,
    }).eq("id", clinic.id);

    // 2) clone a Vapi assistant for this clinic
    const templateId = process.env.VAPI_TEMPLATE_ASSISTANT_ID;
    let vapiAssistantId: string | null = null;
    if (templateId) {
      vapiAssistantId = await cloneVapiAssistant({
        templateAssistantId: templateId,
        clinicName,
        clinicPhone: ownerPhone || "",
        clinicHours: "",
        clinicDentists: "",
        clinicAddress: address ? `${address}, ${city ?? ""}` : city ?? "",
      });
      if (vapiAssistantId) {
        await db().from("clinics").update({ vapi_assistant_id: vapiAssistantId }).eq("id", clinic.id);
      }
    }

    // 3) create the owner auth user; the handle_new_user trigger creates the
    //    public.users row from this metadata (clinic_id) — we don't insert it.
    const tempPassword = Array.from({ length: 16 }, () =>
      "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789".charAt(Math.floor(Math.random() * 54)),
    ).join("");

    await db().auth.admin.createUser({
      email: ownerEmail,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { clinic_id: clinic.id, clinic_name: clinicName, full_name: ownerName },
    });

    // 4) welcome SMS
    if (ownerPhone) {
      await sendSMS(ownerPhone, smsWelcome(ownerName || "there", clinicName)).catch(() => {});
    }

    return NextResponse.json({ success: true, clinicId: clinic.id, vapiAssistantId });
  } catch (err) {
    console.error("[provision] error:", err);
    return NextResponse.json({ error: "Provisioning failed" }, { status: 500 });
  }
}
