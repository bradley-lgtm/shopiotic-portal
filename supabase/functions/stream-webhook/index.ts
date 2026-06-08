import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ---------------------------------------------------------------------------
// Stream Chat webhook — fires on message.new events.
// Sends a Resend email to any @mentioned users.
// ---------------------------------------------------------------------------

const PORTAL_URL = 'https://bradley-lgtm.github.io/shopiotic-portal/'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  let event: any
  try {
    event = await req.json()
  } catch (e) {
    console.error('Failed to parse request body as JSON:', e)
    return new Response('Bad JSON', { status: 400 })
  }

  console.log('Stream event type:', event.type)

  // Only handle message.new with mentions
  if (event.type !== 'message.new') {
    return new Response(JSON.stringify({ ok: true, skipped: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const message = event.message
  const mentionedUsers: Array<{ id: string; name?: string }> = message?.mentioned_users || []

  if (!mentionedUsers.length) {
    console.log('No mentions in message, skipping')
    return new Response(JSON.stringify({ ok: true, no_mentions: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Don't notify the sender of their own mention
  const senderId = message?.user?.id
  const senderName = message?.user?.name || 'Someone'
  const messageText = message?.text || ''
  const toNotify = mentionedUsers.filter(u => u.id !== senderId)

  if (!toNotify.length) {
    return new Response(JSON.stringify({ ok: true, self_mention: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Get client name from channel ID
  // Channel IDs are like teamABCDEF or clientABCDEF
  const channelId: string = event.channel_id || ''
  const safeClientId = channelId.replace(/^(team|client)/, '')
  const isClientChat = channelId.startsWith('client')
  const channelLabel = isClientChat ? 'Client Chat' : 'Team Chat'

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Get client name
  let clientName = 'a client'
  if (safeClientId) {
    const { data: clientRow } = await supabase
      .from('shopiotic_clients')
      .select('name, data')
      .eq('id', safeClientId)
      .maybeSingle()
    clientName = clientRow?.name || clientRow?.data?.name || clientName
  }

  // Get profiles (email + name) for all mentioned users
  const userIds = toNotify.map(u => u.id)
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, email, name, first_name, last_name')
    .in('id', userIds)

  if (!profiles?.length) {
    console.log('No profiles found for mentioned users')
    return new Response(JSON.stringify({ ok: true, no_profiles: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) {
    console.error('RESEND_API_KEY not set')
    return new Response(JSON.stringify({ ok: false, error: 'Resend not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const results = await Promise.allSettled(profiles.map(async (profile) => {
    if (!profile.email) {
      console.log('No email for profile', profile.id)
      return
    }

    const firstName = profile.first_name || profile.name?.split(' ')[0] || 'there'
    const safeText = messageText.replace(/</g, '&lt;').replace(/>/g, '&gt;')

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08);">
    <div style="background:#0d0d0f;padding:24px 32px;text-align:center;">
      <img src="https://bradley-lgtm.github.io/shopiotic-portal/logo-white.png"
           alt="Shopiotic" style="height:32px;width:auto;">
    </div>
    <div style="padding:32px;">
      <p style="font-size:16px;color:#18181f;margin:0 0 8px;font-weight:600;">Hey ${firstName} 👋</p>
      <p style="font-size:14px;color:#48485c;margin:0 0 20px;line-height:1.6;">
        <strong>${senderName}</strong> mentioned you in the <strong>${clientName}</strong> ${channelLabel}.
      </p>
      <div style="background:#f5f3ff;border-left:3px solid #7c3aed;border-radius:0 8px 8px 0;padding:14px 16px;margin:0 0 24px;">
        <div style="font-size:11px;color:#9898b0;margin-bottom:4px;">${senderName}</div>
        <div style="font-size:14px;color:#323244;line-height:1.5;">${safeText}</div>
      </div>
      <a href="${PORTAL_URL}" style="display:block;text-align:center;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;text-decoration:none;padding:13px 24px;border-radius:8px;font-size:14px;font-weight:700;">
        Reply in Portal →
      </a>
    </div>
    <div style="padding:16px 32px;background:#f9f9fb;border-top:1px solid #e8e8f0;text-align:center;">
      <p style="font-size:11px;color:#9898b0;margin:0;">
        You're receiving this because you were @mentioned in the Shopiotic Ops Portal.
      </p>
    </div>
  </div>
</body>
</html>`

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Shopiotic Portal <notifications@shopiotic.com>',
        to: profile.email,
        subject: `💬 ${senderName} mentioned you in ${clientName}`,
        html,
      }),
    })

    const result = await res.json()
    console.log('Email sent to', profile.email, '→', res.status, result?.id || result?.message)
  }))

  const sent = results.filter(r => r.status === 'fulfilled').length
  console.log(`Mention emails: ${sent}/${profiles.length} sent`)

  return new Response(JSON.stringify({ ok: true, sent, total: profiles.length }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
})
