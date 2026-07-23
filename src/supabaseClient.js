import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = 'https://qdikrhoxkkangkoycagj.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkaWtyaG94a2thbmdrb3ljYWdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMzU5MjksImV4cCI6MjA5ODgxMTkyOX0.gbAZ8Wtxyh0VWlnODAWmopzS9EmJhx3JkslDgbEKnQ8'

export const CONFIG_READY =
  SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 20

export const supabase = CONFIG_READY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null
