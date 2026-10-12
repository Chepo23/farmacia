const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Sin internet una consulta no debe congelar la caja: se corta a los pocos segundos
// y no se reintenta (el inventario tiene su propia cola de reintentos).
const TIEMPO_LIMITE_MS = Number(process.env.SUPABASE_TIMEOUT_MS) || 8000;

function createClientWithKey(key) {
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: { timeout: TIEMPO_LIMITE_MS, retry: false },
  });
}

const supabaseAnon = createClientWithKey(anonKey);
const supabaseAdmin = createClientWithKey(serviceKey) || supabaseAnon;

module.exports = {
  supabaseAnon,
  supabaseAdmin,
  hasSupabase: Boolean(url && (anonKey || serviceKey)),
};
