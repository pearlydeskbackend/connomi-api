import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { sendSMS, smsWelcome } from '@/lib/twilio'
import { cloneVapiAssistant } from '@/lib/vapi'

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-admin-secret') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { clinicName, ownerName, ownerEmail, ownerPhone, address, city, hours, dentists, googleReviewLink, stripeCustomerId, stripeSubscriptionId, plan } = await req.json() as Record<string, string>

    if (!clinicName || !ownerEmail) {
      return NextResponse.json({ error: 'clinicName and ownerEmail required' }, { status: 400 })
    }

    const { data: clinic, error: clinicError } = await supabase
      .from('clinics')
      .insert({
        name: clinicName, owner_name: ownerName, owner_email: ownerEmail,
        owner_phone: ownerPhone, address, city, hours: hours || 'Mon-Fri 9am-5pm',
        dentists, google_review_link: googleReviewLink,
        stripe_customer_id: stripeCustomerId, stripe_subscription_id: stripeSubscriptionId,
        plan: plan || 'starter', active: true,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      })
      .select().single()

    if (clinicError || !clinic) {
      return NextResponse.json({ error: 'Failed to create clinic' }, { status: 500 })
    }

    const templateId = process.env.VAPI_TEMPLATE_ASSISTANT_ID
    let vapiAssistantId: string | null = null

    if (templateId) {
      vapiAssistantId = await cloneVapiAssistant({
        templateAssistantId: templateId,
        clinicName, clinicPhone: ownerPhone || '',
        clinicHours: hours || 'Mon-Fri 9am-5pm',
        clinicDentists: dentists || '',
        clinicAddress: address ? `${address}, ${city || ''}` : city || '',
      })
      if (vapiAssistantId) {
        await supabase.from('clinics').update({ vapi_assistant_id: vapiAssistantId }).eq('id', clinic.id)
      }
    }

    const tempPassword = Array.from({ length: 12 }, () =>
      'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'.charAt(Math.floor(Math.random() * 55))
    ).join('')

    const { error: authError, data: authData } = await supabase.auth.admin.createUser({
      email: ownerEmail, password: tempPassword, email_confirm: true,
      user_metadata: { clinic_id: clinic.id, clinic_name: clinicName },
    })

    if (!authError && authData.user) {
      await supabase.from('users').insert({
        id: authData.user.id, clinic_id: clinic.id,
        email: ownerEmail, role: 'owner', created_at: new Date().toISOString(),
      })
    }

    if (ownerPhone) {
      await sendSMS(ownerPhone, smsWelcome(ownerName || 'there', clinicName))
    }

    console.log(`[provision] Complete — ${clinicName} is live (${clinic.id})`)

    return NextResponse.json({ success: true, clinicId: clinic.id, vapiAssistantId })
  } catch (err) {
    console.error('[provision] Error:', err)
    return NextResponse.json({ error: 'Provisioning failed' }, { status: 500 })
  }
}