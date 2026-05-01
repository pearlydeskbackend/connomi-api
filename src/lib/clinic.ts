import { supabase } from '@/lib/supabase'
import type { Clinic } from '@/lib/supabase'

export async function getClinicById(id: string): Promise<Clinic | null> {
  const { data, error } = await supabase
    .from('clinics')
    .select('*')
    .eq('id', id)
    .eq('active', true)
    .single()

  if (error) {
    console.error('[clinic] getClinicById error:', error.message)
    return null
  }
  return data
}

export async function getClinicByPhone(phone: string): Promise<Clinic | null> {
  // Normalize the phone number before lookup
  // Try the exact number first, then with +1 prefix, then without
  const attempts = [
    phone,
    phone.startsWith('+') ? phone : `+${phone}`,
    phone.startsWith('+1') ? phone.slice(2) : phone,
    phone.replace(/\D/g, ''),
    `+1${phone.replace(/\D/g, '').slice(-10)}`,
  ]

  console.log('[clinic] Trying phone lookups:', attempts)

  for (const attempt of attempts) {
    const { data, error } = await supabase
      .from('clinics')
      .select('*')
      .eq('twilio_phone', attempt)
      .eq('active', true)
      .single()

    if (!error && data) {
      console.log('[clinic] Found clinic with phone attempt:', attempt)
      return data
    }
  }

  console.error('[clinic] No clinic found for any phone format of:', phone)
  return null
}

export async function resolveClinic(
  clinicId: string | null,
  toNumber: string | null
): Promise<Clinic | null> {
  console.log('[clinic] resolveClinic called — clinicId:', clinicId, 'toNumber:', toNumber)

  // Method 1 — explicit clinic_id
  if (clinicId) {
    const clinic = await getClinicById(clinicId)
    if (clinic) {
      console.log('[clinic] Resolved by ID:', clinic.name)
      return clinic
    }
    console.warn('[clinic] ID not found — trying phone fallback')
  }

  // Method 2 — phone number lookup
  if (toNumber) {
    const clinic = await getClinicByPhone(toNumber)
    if (clinic) {
      console.log('[clinic] Resolved by phone:', clinic.name)
      return clinic
    }
  }

  // Method 3 — FALLBACK: if only one clinic exists return it
  // This handles the case where Vapi does not send phone number correctly
  console.log('[clinic] Trying fallback — checking if only one active clinic exists')
  const { data: allClinics } = await supabase
    .from('clinics')
    .select('*')
    .eq('active', true)

  if (allClinics && allClinics.length === 1) {
    console.log('[clinic] Single clinic fallback:', allClinics[0].name)
    return allClinics[0]
  }

  console.error('[clinic] Could not resolve clinic')
  return null
}