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
  const { data, error } = await supabase
    .from('clinics')
    .select('*')
    .eq('twilio_phone', phone)
    .eq('active', true)
    .single()

  if (error) {
    console.error('[clinic] getClinicByPhone error:', error.message)
    return null
  }
  return data
}

export async function resolveClinic(
  clinicId: string | null,
  toNumber: string | null
): Promise<Clinic | null> {
  if (clinicId) {
    const clinic = await getClinicById(clinicId)
    if (clinic) {
      console.log(`[clinic] Resolved by ID: ${clinic.name}`)
      return clinic
    }
    console.warn(`[clinic] ID not found — trying phone fallback`)
  }

  if (toNumber) {
    const clinic = await getClinicByPhone(toNumber)
    if (clinic) {
      console.log(`[clinic] Resolved by phone: ${clinic.name}`)
      return clinic
    }
    console.error(`[clinic] No clinic found for phone: ${toNumber}`)
  }

  console.error('[clinic] Could not resolve clinic')
  return null
}