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

// Upsert one or many users in Stream (minimal data — name updated on actual login)
async function upsertStreamUsers(users: Array<{ id: string; name?: string; image?: string | null }>, serverToken: string): Promise<void> {
  if (!users.length) return
  const usersMap: Record<string, { id: string; name?: string; image?: string }> = {}
  for (const u of users) {
    usersMap[u.id] = { id: u.id, ...(u.name ? { name: u.name } : {}), ...(u.image ? { image: u.image } : {}) }
  }
  await streamRequest('/users', { users: usersMap }, serverToken)
}

// Create a messaging channel then add members.
// Uses /query to create (no-ops if already exists), then add_members.
async function upsertChannel(
  channelId: string,
  name: string,
  memberIds: string[],
  createdById: string,
  serverToken: string,
): Promise<void> {
  // /query creates the channel if it doesn't exist, updates it if it does
  await streamRequest(`/channels/messaging/${channelId}/query`, {
    data: { name, created_by_id: createdById },
    watch: false,
    state: false,
  }, serverToken)

  // Add members separately (idempotent)
  if (memberIds.length > 0) {
    await streamRequest(`/channels/messaging/${channelId}`, {
      add_members: memberIds.map(id => ({ user_id: id })),
    }, serverToken)
  }
  console.log(`Channel messaging:${channelId} ready with ${memberIds.length} members`)
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
      const { data: access } = await adminSupabase
        .from('client_access')
        .select('client_id')
        .eq('user_id', user.id)
      accessibleClientIds = access?.map(a => a.client_id) || []
    }

    // Get ALL worker IDs across all accessible clients
    const allWorkerIds: string[] = []
    if (accessibleClientIds.length > 0) {
      const { data: allAssigned } = await adminSupabase
        .from('client_access')
        .select('user_id')
        .in('client_id', accessibleClientIds)
      if (allAssigned) allWorkerIds.push(...allAssigned.map(a => a.user_id))
    }

    // Upsert ALL users involved (current user + owners + workers) in Stream before creating channels.
    // Stream requires users to exist before they can be added as channel members.
    // Fetch real names for everyone so @mentions show names not UUIDs.
    const allUserIds = [...new Set([user.id, ...ownerIds, ...allWorkerIds])]

    const { data: allProfiles } = await adminSupabase
      .from('profiles')
      .select('id, name, first_name, last_name, avatar_url')
      .in('id', allUserIds)

    const profileMap = new Map((allProfiles || []).map(p => {
      const n = (p.first_name && p.last_name)
        ? `${p.first_name} ${p.last_name}`.trim()
        : (p.name || p.id)
      return [p.id, { name: n, image: p.avatar_url || null }]
    }))
    profileMap.set(user.id, { name: displayName, image: allProfiles?.find(p => p.id === user.id)?.avatar_url || null })

    console.log(`Upserting ${allUserIds.length} users in Stream`)
    await upsertStreamUsers(
      allUserIds.map(id => {
        const info = profileMap.get(id) || { name: id, image: null }
        return { id, name: info.name, ...(info.image ? { image: info.image } : {}) }
      }),
      serverToken
    ).catch(e => console.warn('Batch user upsert failed:', e))

    console.log(`Setting up channels for ${accessibleClientIds.length} clients, role=${role}`)

    const channelResults = await Promise.allSettled(accessibleClientIds.map(async (clientId: string) => {
      const safeId = clientId.replace(/-/g, '')

      const { data: assigned } = await adminSupabase
        .from('client_access')
        .select('user_id')
        .eq('client_id', clientId)
      const workerIds: string[] = assigned?.map(a => a.user_id) || []

      const teamMembers = [...new Set([...ownerIds, ...workerIds])]
      console.log(`Client ${clientId}: ${teamMembers.length} members`)

      const results = await Promise.allSettled([
        upsertChannel(`team${safeId}`,   'Team Chat',   teamMembers, user.id, serverToken),
        upsertChannel(`client${safeId}`, 'Client Chat', teamMembers, user.id, serverToken),
      ])
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.error(`channel ${i===0?'team':'client'}${safeId} FAILED:`, r.reason)
      })
    }))

    channelResults.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`Client ${accessibleClientIds[i]} setup failed:`, r.reason)
    })

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
