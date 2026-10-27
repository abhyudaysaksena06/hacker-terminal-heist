// Supabase Edge Function: the whole game API at /functions/v1/game/*.
// Deploy: npx supabase functions deploy game
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createHandler } from '../_shared/api.js';
import { serve } from '../_shared/http.js';
import { pgStore } from '../_shared/pg-store.js';

// Both values are injected by Supabase into every Edge Function.
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// The frontend signs players in anonymously; their access token identifies them.
async function verifyPlayer(token: string): Promise<string | null> {
  const { data, error } = await db.auth.getUser(token);
  return error || !data.user ? null : data.user.id;
}

Deno.serve(serve(createHandler({ store: pgStore(db), verifyPlayer })));
