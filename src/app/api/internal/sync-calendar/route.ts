import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-internal-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const appUrl  = process.env.NEXT_PUBLIC_APP_URL || 'https://pearlydesk-api.vercel.app'
    const response = await fetch(`${appUrl}/api/cron/sync-calendar`, {
      headers: {
        'x-cron-secret': process.env.CRON_SECRET || '',
      },
    })

    const result = await response.json()
    return NextResponse.json(result)
  } catch (err) {
    console.error('[sync-calendar-manual] Error:', err)
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
}