import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = 'https://qdikrhoxkkangkoycagj.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkaWtyaG94a2thbmdrb3ljYWdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMzU5MjksImV4cCI6MjA5ODgxMTkyOX0.gbAZ8Wtxyh0VWlnODAWmopzS9EmJhx3JkslDgbEKnQ8'

export const CONFIG_READY =
  SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 20

export const supabase = CONFIG_READY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null

// ---------------------------------------------------------------------------
// Connex (separate Supabase project) - read-only source of the user's contacts
// for network-aware CV / cover-letter generation. Public anon key by design;
// contacts are protected by Connex's own auth + RLS, not key secrecy. A distinct
// storageKey keeps the Connex auth session separate from HiyakuAI's own session.
// ---------------------------------------------------------------------------
export const CONNEX_URL = 'https://pvqwpzbjremcyobnsldd.supabase.co'
export const CONNEX_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2cXdwemJqcmVtY3lvYm5zbGRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NTM1MDUsImV4cCI6MjA5NzQyOTUwNX0.mWlrpj-B9ylnOqcy5ppiPGGYJonU8MdZ1ZzO73-GvM8'

export const connex = createClient(CONNEX_URL, CONNEX_ANON_KEY, {
  auth: { storageKey: 'connex-auth-token', persistSession: true, autoRefreshToken: true },
})
