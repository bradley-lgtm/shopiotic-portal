import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ---------------------------------------------------------------------------
// Generates a signed Stream Chat user token AND ensures all messaging channels
// for this user's accessible clients exist with correct members.
// Uses server-side admin credentials so channel creation always succeeds
// regardless of the user's Stream role.
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

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// User JWT — identifies the connecting user
async function generateUserToken(userId: string, secret: string): Promise<string> {
  const header  = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = toBase64Url(JSON.stringify({ user_id: userId }))
  const sig = await hmacSign(secret, `${header}.${payload}`)
  return `${header}.${payload}.${sig}`
}

// Server JWT — grants admin access to Stream REST API
async function generateServerToken(secret: string): Promise<string> {
  const header  = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = toBase64Url(JSON.stringify({ server: true }))
  const sig = await hmacSign(secret, `${header}.${payload}`)
  return `${header}.${payload}.${sig}`
}

// Call Stream REST API with server credentials
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

// Ensure a user exists in Stream (upsert their name/data)
async function upsertStreamUser(userId: string, name: string, serverToken: string): Promise<void> {
  await streamRequest('/users', {
    users: { [userId]: { id: userId, name } },
  }, serverToken)
}

// Create or update a messaging channel with the given members
async function upsertChannel(
  channelId: string,
  name: string,
  memberIds: string[],
  createdById: string,
  serverToken: string,
): Promise<void> {
  // Create/update the channel
  await streamRequest(`/channels/messaging/${channelId}`, {
    data: { name, created_by_id: createdById },
  }, serverToken)

  // Add all members (idempotent — safe to call even if already members)
  if (memberIds.length > 0) {
    await streamRequest(`/channels/messaging/${channelId}/members`, {
      add_members: memberIds.map(id => ({ user_id: id })),
    }, serverToken)
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

  const secret = Deno.env.get('STREAM_SECRET')
  if (!secret) {
    return new Response(JSON.stringify({ error: 'STREAM_SECRET not set' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  try {
    // Generate both tokens
    const [userToken, serverToken] = await Promise.all([
      generateUserToken(user.id, secret),
      generateServerToken(secret),
    ])

    // Use service role for Supabase admin queries
    const adminSupabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Get user's profile (role + display name)
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('role, name, first_name, last_name')
      .eq('id', user.id)
      .single()

    const role        = profile?.role || 'worker'
    const displayName = (profile?.first_name && profile?.last_name)
      ? `${profile.first_name} ${profile.last_name}`.trim()
      : (profile?.name || user.email || user.id)

    // Ensure user exists in Stream with their current name
    await upsertStreamUser(user.id, displayName, serverToken).catch(e =>
      console.warn('upsertStreamUser failed:', e)
    )

    // Get all owner IDs (owners are members of every client's channels)
    const { data: ownerProfiles } = await adminSupabase
      .from('profiles')
      .select('id')
      .eq('role', 'owner')
    const ownerIds: string[] = ownerProfiles?.map(p => p.id) || []

    // Determine which clients this user has access to
    let accessibleClientIds: string[] = []
    if (role === 'owner') {
      const { data: allClients } = await adminSupabase
        .from('shopiotic_clients')
        .select('id')
      accessibleClientIds = allClients?.map(c => c.id) || []
    } else {
      // worker or client role — look up client_access
      const { data: access } = await adminSupabase
        .from('client_access')
        .select('client_id')
        .eq('user_id', user.id)
      accessibleClientIds = access?.map(a => a.client_id) || []
    }

    // For each accessible client, upsert both team + client channels
    await Promise.allSettled(accessibleClientIds.map(async (clientId: string) => {
      const safeId = clientId.replace(/-/g, '')

      // Get workers assigned to this client
      const { data: assigned } = await adminSupabase
        .from('client_access')
        .select('user_id')
        .eq('client_id', clientId)
      const workerIds: string[] = assigned?.map(a => a.user_id) || []

      const teamMembers = [...new Set([...ownerIds, ...workerIds])]

      await Promise.allSettled([
        upsertChannel(`team${safeId}`,   'Team Chat',   teamMembers, user.id, serverToken),
        upsertChannel(`client${safeId}`, 'Client Chat', teamMembers, user.id, serverToken),
      ])
    }))

    return new Response(JSON.stringify({ token: userToken, userId: user.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (e) {
    console.error('generate-stream-token error:', e)
    return new Response(JSON.stringify({ error: 'Token generation failed', detail: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
