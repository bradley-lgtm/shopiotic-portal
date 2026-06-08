import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ---------------------------------------------------------------------------
// Stream Chat webhook handler — fires on message.new events.
// Sends an email via Resend when a user is @mentioned.
//
// Required secrets (set via Supabase dashboard → Edge Functions → Secrets):
//   STREAM_WEBHOOK_SECRET  — from Stream dashboard → Webhooks → signing secret
//   RESEND_API_KEY         — your Resend API key
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase
// ---------------------------------------------------------------------------

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const body = await req.text()

  // Verify Stream webhook signature
  const webhookSecret = Deno.env.get('STREAM_WEBHOOK_SECRET')
  if (webhookSecret) {
    const signature = req.headers.get('x-signature') || ''
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
    const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('')
    if (signature !== expected) {
      console.warn('Webhook signature mismatch — ignoring')
      return new Response('Unauthorized', { status: 401 })
    }
  }

  let event: any
  try { event = JSON.parse(body) } catch {
    return new Response('Bad JSON', { status: 400 })
  }

  // Only handle message.new events that have mentions
  if (event.type !== 'message.new') {
    return new Response(JSON.stringify({ ok: true, skipped: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const message = event.message
  const mentionedUsers: Array<{ id: string; name?: string }> = message?.mentioned_users || []
  if (!mentionedUsers.length) {
    return new Response(JSON.stringify({ ok: true, no_mentions: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Don't notify the sender of their own mention
  const senderId = message?.user?.id
  const toNotify = mentionedUsers.filter(u => u.id !== senderId)
  if (!toNotify.length) {
    return new Response(JSON.stringify({ ok: true, self_mention: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Look up emails from Supabase profiles
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const userIds = toNotify.map(u => u.id)
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, name, email:id') // we'll get email from auth.users join
    .in('id', userIds)

  // Get emails via auth.admin (service role required)
  const emails: Array<{ name: string; email: string }> = []
  for (const uid of userIds) {
    const { data: { user } } = await supabase.auth.admin.getUserById(uid)
    if (user?.email) {
      const prof = profiles?.find(p => p.id === uid)
      emails.push({ name: prof?.name || user.email, email: user.email })
    }
  }

  if (!emails.length) {
    return new Response(JSON.stringify({ ok: true, no_emails: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Send email via Resend
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) {
    console.error('RESEND_API_KEY not set')
    return new Response(JSON.stringify({ ok: false, error: 'Resend not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const senderName = message?.user?.name || 'Someone'
  const channelName = event.channel_type === 'livestream'
    ? (event.channel_id?.includes('client') ? 'Client Chat' : 'Team Chat')
    : 'Chat'
  const msgText = message?.text || ''

  const results = await Promise.allSettled(emails.map(({ name, email }) =>
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Shopiotic Portal <notifications@shopiotic.com>',
        to: [email],
        subject: `${senderName} mentioned you in ${channelName}`,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#f9f9f9;">
            <div style="background:#fff;border-radius:12px;padding:28px 24px;border:1px solid #e5e7eb;">
              <div style="font-size:22px;font-weight:700;color:#1a1a2e;margin-bottom:4px;">💬 You were mentioned</div>
              <div style="font-size:14px;color:#6b7280;margin-bottom:24px;">${senderName} mentioned you in <strong>${channelName}</strong></div>
              <div style="background:#f3f4f6;border-radius:8px;padding:16px;font-size:15px;color:#374151;border-left:4px solid #7c3aed;">
                ${msgText.replace(/</g,'&lt;').replace(/>/g,'&gt;')}
              </div>
              <div style="margin-top:24px;">
                <a href="https://bradley-lgtm.github.io/shopiotic-portal/"
                   style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">
                  Open Portal →
                </a>
              </div>
              <div style="margin-top:20px;font-size:12px;color:#9ca3af;">Shopiotic Ops Portal • You received this because you were mentioned in a chat message.</div>
            </div>
          </div>
        `,
      }),
    })
  ))

  const sent = results.filter(r => r.status === 'fulfilled').length
  console.log(`Mention emails sent: ${sent}/${emails.length}`)

  return new Response(JSON.stringify({ ok: true, sent, total: emails.length }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
})
