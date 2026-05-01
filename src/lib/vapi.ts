import { NextResponse } from 'next/server'

export function vapiSuccess(toolCallId: string, message: string): NextResponse {
  return NextResponse.json({ results: [{ toolCallId, result: message }] })
}

export function vapiError(toolCallId: string, message: string): NextResponse {
  return NextResponse.json({ results: [{ toolCallId, result: message }] })
}

export function extractToolCall(body: Record<string, unknown>) {
  try {
    console.log('[vapi] Body received:', JSON.stringify(body, null, 2))

    const message = (body?.message ?? body) as Record<string, unknown>

    const toolCalls = (
      message?.toolCalls ?? message?.tool_calls
    ) as Array<Record<string, unknown>> | undefined

    const toolCall = toolCalls?.[0]

    if (!toolCall) {
      console.log('[vapi] No tool call found')
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

    const call = (message?.call ?? body?.call) as Record<string, unknown> | undefined
    const metadata = call?.metadata as Record<string, string> | undefined
    const clinicId = metadata?.clinic_id ?? null

    const phoneNumberObj = (
      call?.phoneNumber ?? call?.phone_number
    ) as Record<string, unknown> | undefined

    const toNumber = (
      phoneNumberObj?.number ??
      phoneNumberObj?.phoneNumber ??
      call?.to
    ) as string | null ?? null

    const result = {
      toolCallId: String(toolCall.id ?? 'unknown'),
      toolName:   String(fn?.name ?? ''),
      args,
      clinicId,
      toNumber,
    }

    console.log('[vapi] Extracted:', result)
    return result
  } catch (err) {
    console.error('[vapi] extractToolCall error:', err)
    return null
  }
}

export async function triggerVapiCall(params: {
  assistantId: string
  phoneNumberId: string
  customerPhone: string
  customerName: string
  variables?: Record<string, string>
}): Promise<boolean> {
  try {
    const response = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assistantId:   params.assistantId,
        phoneNumberId: params.phoneNumberId,
        customer: { number: params.customerPhone, name: params.customerName },
        assistantOverrides: {
          variableValues: {
            patientName: params.customerName,
            ...(params.variables || {}),
          },
        },
      }),
    })
    if (!response.ok) {
      console.error('[vapi] Call failed:', await response.text())
      return false
    }
    return true
  } catch (err) {
    console.error('[vapi] triggerVapiCall error:', err)
    return false
  }
}

export async function cloneVapiAssistant(params: {
  templateAssistantId: string
  clinicName: string
  clinicPhone: string
  clinicHours: string
  clinicDentists: string
  clinicAddress: string
}): Promise<string | null> {
  try {
    const apiKey = process.env.VAPI_API_KEY
    if (!apiKey) return null

    const getRes = await fetch(`https://api.vapi.ai/assistant/${params.templateAssistantId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!getRes.ok) return null

    const template  = await getRes.json() as Record<string, unknown>
    const modelData = template.model as Record<string, unknown> | undefined
    const messages  = modelData?.messages as Array<Record<string, unknown>> | undefined
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
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...rest,
        name: `Pearly — ${params.clinicName}`,
        model: { ...modelData, messages: [{ role: 'system', content: systemPrompt }] },
      }),
    })
    if (!createRes.ok) return null

    const newAssistant = await createRes.json() as { id: string }
    console.log('[vapi] Assistant cloned:', newAssistant.id)
    return newAssistant.id
  } catch (err) {
    console.error('[vapi] cloneVapiAssistant error:', err)
    return null
  }
}