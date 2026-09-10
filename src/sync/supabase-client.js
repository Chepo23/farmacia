const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function createClientWithKey(key) {
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

const supabaseAnon = createClientWithKey(anonKey);
const supabaseAdmin = createClientWithKey(serviceKey) || supabaseAnon;

module.exports = {
  supabaseAnon,
  supabaseAdmin,
  hasSupabase: Boolean(url && (anonKey || serviceKey)),
};
