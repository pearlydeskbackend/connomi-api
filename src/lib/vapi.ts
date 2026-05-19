import { NextRequest, NextResponse } from 'next/server'

// ─── SENSITIVE FIELD REDACTION ────────────────────────────────────────────────
// Strips credentials before logging — Twilio tokens were appearing in Vercel logs

const SENSITIVE_KEYS = new Set([
  'twilioauthtoken', 'twilioaccountsid', 'authorization',
  'token', 'secret', 'password', 'key', 'apikey', 'api_key',
  'accesstoken', 'access_token', 'privatekey', 'private_key',
])

function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 5 || obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(item => redactSensitive(item, depth + 1))
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      result[k] = '[REDACTED]'
    } else {
      result[k] = redactSensitive(v, depth + 1)
    }
  }
  return result
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
// In-memory — resets on cold start (acceptable for now)
// Replace with Upstash Redis at clinic #5+

interface RateEntry {
  count:   number
  resetAt: number
}

const rateLimitStore = new Map<string, RateEntry>()
const RATE_LIMIT_MAX    = 10
const RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute

export function checkRateLimit(key: string): { allowed: boolean; remaining: number } {
  const now   = Date.now()
  const entry = rateLimitStore.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 }
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 }
  }

  entry.count++
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count }
}

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) rateLimitStore.delete(key)
  }
}, 5 * 60 * 1000)

// ─── WEBHOOK SECRET VERIFICATION ─────────────────────────────────────────────
// Vapi sends x-pearly-secret header when configured in assistant server settings
// Falls back to allowing if secret not configured (backward compatible)

export function verifyVapiSecret(req: NextRequest): boolean {
  const secret = process.env.VAPI_WEBHOOK_SECRET
  if (!secret) return true // not configured — allow all
  const header = req.headers.get('x-pearly-secret')
  return header === secret
}

// ─── RESPONSE HELPERS ─────────────────────────────────────────────────────────

export function vapiSuccess(toolCallId: string, message: string): NextResponse {
  return NextResponse.json({ results: [{ toolCallId, result: message }] })
}

export function vapiError(toolCallId: string, message: string): NextResponse {
  return NextResponse.json({ results: [{ toolCallId, result: message }] })
}

export function vapiRateLimited(toolCallId: string): NextResponse {
  return NextResponse.json({
    results: [{ toolCallId, result: 'I am having trouble right now. Please call us directly.' }]
  })
}

// ─── TOOL CALL EXTRACTOR ──────────────────────────────────────────────────────

export function extractToolCall(body: Record<string, unknown>) {
  try {
    // Redact sensitive fields before logging — prevents credential exposure in Vercel logs
    const safeBody = redactSensitive(body)
    console.log('[vapi] RAW BODY:', JSON.stringify(safeBody, null, 2))

    const message = (body?.message ?? body) as Record<string, unknown>

    const toolCalls = (
      message?.toolCalls ?? message?.tool_calls
    ) as Array<Record<string, unknown>> | undefined

    const toolCall = toolCalls?.[0]

    if (!toolCall) {
      console.log('[vapi] No tool call found. Message keys:', Object.keys(message))
      return null
    }

    const fn = (toolCall.function ?? toolCall.fn) as Record<string, unknown> | undefined

    let args: Record<string, string> = {}
    const rawArgs = fn?.arguments ?? fn?.args

    if (typeof rawArgs === 'string') {
      try { args = JSON.parse(rawArgs) } catch { args = {} }
    } else if (typeof rawArgs === 'object' && rawArgs !== null) {
      args = rawArgs as Record<string, string>
    }

    const call = (
      message?.call ?? body?.call
    ) as Record<string, unknown> | undefined

    console.log('[vapi] call object keys:', Object.keys(call || {}))

    const metadata = call?.metadata as Record<string, string> | undefined
    const clinicId = metadata?.clinic_id ?? null

    const phoneNumberObj = (
      call?.phoneNumber ??
      call?.phone_number ??
      call?.to
    ) as Record<string, unknown> | string | undefined

    let toNumber: string | null = null

    if (typeof phoneNumberObj === 'string') {
      toNumber = phoneNumberObj
    } else if (typeof phoneNumberObj === 'object' && phoneNumberObj !== null) {
      toNumber = (
        (phoneNumberObj as Record<string, unknown>).number ??
        (phoneNumberObj as Record<string, unknown>).phoneNumber ??
        null
      ) as string | null
    }

    if (!toNumber && typeof call?.to === 'string') {
      toNumber = call.to as string
    }

    if (!toNumber) {
      const msgPhoneObj = message?.phoneNumber as Record<string, unknown> | undefined
      if (msgPhoneObj?.number) {
        toNumber = msgPhoneObj.number as string
      }
    }

    console.log('[vapi] toNumber extracted:', toNumber)

    const result = {
      toolCallId: String(toolCall.id ?? 'unknown'),
      toolName:   String(fn?.name ?? ''),
      args,
      clinicId,
      toNumber,
    }

    console.log('[vapi] Final extracted result:', JSON.stringify(result, null, 2))
    return result
  } catch (err) {
    console.error('[vapi] extractToolCall error:', err)
    return null
  }
}

// ─── OUTBOUND CALL TRIGGER ────────────────────────────────────────────────────

export async function triggerVapiCall(params: {
  assistantId:   string
  phoneNumberId: string
  customerPhone: string
  customerName:  string
  variables?:    Record<string, string>
}): Promise<boolean> {
  try {
    const response = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${process.env.VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assistantId:   params.assistantId,
        phoneNumberId: params.phoneNumberId,
        customer: {
          number: params.customerPhone,
          name:   params.customerName,
        },
        assistantOverrides: {
          variableValues: {
            patientName: params.customerName,
            ...(params.variables || {}),
          },
        },
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('[vapi] Call failed:', errText)

      if (response.status === 429) {
        console.error('[vapi] Rate limited by Vapi — too many outbound calls')
      } else if (response.status === 400) {
        console.error('[vapi] Bad request — likely invalid phone number:', params.customerPhone)
      } else if (response.status === 401) {
        console.error('[vapi] Unauthorized — check VAPI_API_KEY env var')
      }

      return false
    }

    return true
  } catch (err) {
    console.error('[vapi] triggerVapiCall error:', err)
    return false
  }
}

// ─── ASSISTANT CLONING ────────────────────────────────────────────────────────

export async function cloneVapiAssistant(params: {
  templateAssistantId: string
  clinicName:          string
  clinicPhone:         string
  clinicHours:         string
  clinicDentists:      string
  clinicAddress:       string
}): Promise<string | null> {
  try {
    const apiKey = process.env.VAPI_API_KEY
    if (!apiKey) return null

    const getRes = await fetch(`https://api.vapi.ai/assistant/${params.templateAssistantId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!getRes.ok) return null

    const template     = await getRes.json() as Record<string, unknown>
    const modelData    = template.model as Record<string, unknown> | undefined
    const messages     = modelData?.messages as Array<Record<string, unknown>> | undefined
    const systemPrompt = String(messages?.[0]?.content || '')
      .replace(/\{\{clinicName\}\}/g,     params.clinicName)
      .replace(/\{\{clinicPhone\}\}/g,    params.clinicPhone)
      .replace(/\{\{clinicHours\}\}/g,    params.clinicHours)
      .replace(/\{\{clinicDentists\}\}/g, params.clinicDentists)
      .replace(/\{\{clinicAddress\}\}/g,  params.clinicAddress)

    const { id: _a, createdAt: _b, updatedAt: _c, orgId: _d, ...rest } =
      template as Record<string, unknown>
    void _a; void _b; void _c; void _d

    const createRes = await fetch('https://api.vapi.ai/assistant', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...rest,
        name:  `Pearly — ${params.clinicName}`,
        model: {
          ...modelData,
          messages: [{ role: 'system', content: systemPrompt }],
        },
      }),
    })

    if (!createRes.ok) return null

    const newAssistant = await createRes.json() as { id: string }
    return newAssistant.id
  } catch (err) {
    console.error('[vapi] cloneVapiAssistant error:', err)
    return null
  }
}