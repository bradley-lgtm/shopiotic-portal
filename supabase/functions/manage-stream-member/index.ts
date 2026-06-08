import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ---------------------------------------------------------------------------
// Adds or removes a user from a client's Stream messaging channels.
// Called when a worker is assigned to or removed from a client in the portal.
// Requires the caller to be an authenticated owner.
// ---------------------------------------------------------------------------

const STREAM_API_KEY = '39s5shwef5jf'
const STREAM_API_BASE = 'https://chat.stream-io-api.com'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function toBase64Url(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function generateServerToken(secret: string): Promise<string> {
  const header  = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = toBase64Url(JSON.stringify({ server: true }))
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  return `${header}.${payload}.${sigB64}`
}

async function streamRequest(path: string, body: unknown, serverToken: string): Promise<void> {
  const res = await fetch(`${STREAM_API_BASE}${path}?api_key=${STREAM_API_KEY}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serverToken}`,
      'Stream-Auth-Type': 'jwt',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Stream ${path} → ${res.status}: ${text}`)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Verify caller is an authenticated Supabase user
  const anonSupabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )
  const { data: { user }, error: authError } = await anonSupabase.auth.getUser()
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Only owners can manage channel members
  const adminSupabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'owner') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const secret = Deno.env.get('STREAM_SECRET')
  if (!secret) {
    return new Response(JSON.stringify({ error: 'STREAM_SECRET not set' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  let body: { clientId?: string; userId?: string; action?: string }
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const { clientId, userId, action } = body
  if (!clientId || !userId || !action) {
    return new Response(JSON.stringify({ error: 'clientId, userId and action are required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  if (action !== 'add' && action !== 'remove') {
    return new Response(JSON.stringify({ error: 'action must be "add" or "remove"' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  try {
    const serverToken = await generateServerToken(secret)
    const safeId = clientId.replace(/-/g, '')
    const channels = [`team${safeId}`, `client${safeId}`]

    if (action === 'add') {
      // Upsert the user in Stream first so they exist before being added
      const { data: memberProfile } = await adminSupabase
        .from('profiles')
        .select('id, name, first_name, last_name')
        .eq('id', userId)
        .single()

      const name = (memberProfile?.first_name && memberProfile?.last_name)
        ? `${memberProfile.first_name} ${memberProfile.last_name}`.trim()
        : (memberProfile?.name || userId)

      await streamRequest('/users', {
        users: { [userId]: { id: userId, name } },
      }, serverToken)

      // Add to both channels
      await Promise.allSettled(channels.map(channelId =>
        streamRequest(`/channels/messaging/${channelId}`, {
          add_members: [{ user_id: userId }],
        }, serverToken)
      ))
      console.log(`Added ${userId} to channels for client ${clientId}`)

    } else {
      // Remove from both channels
      await Promise.allSettled(channels.map(channelId =>
        streamRequest(`/channels/messaging/${channelId}`, {
          remove_members: [userId],
        }, serverToken)
      ))
      console.log(`Removed ${userId} from channels for client ${clientId}`)
    }

    return new Response(JSON.stringify({ ok: true, action, userId, clientId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (e) {
    console.error('manage-stream-member error:', e)
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
