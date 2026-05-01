export function formatPhone(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

export function maskPhone(phone: string): string {
  if (phone.length < 4) return '****'
  return `***-***-${phone.slice(-4)}`
}
