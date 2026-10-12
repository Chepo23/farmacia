// Función "movil" de Supabase (Deno): la app del celular habla con esta función, no con las
// computadoras, así funciona aunque las farmacias estén cerradas y sus computadoras apagadas.
//
// Publicarla (instrucciones completas en docs/celular.md):
//   npx supabase functions deploy movil --project-ref TU-PROYECTO --no-verify-jwt --use-api
// La verificación de JWT va apagada porque el celular se identifica con su propia sesión
// (la que obtiene al vincularse con el código de la computadora), no con una llave de Supabase.
//
// Secretos (Supabase → Edge Functions → Secrets):
//   FARMACIA_SECRET_KEY  llave secreta (sb_secret_…) con la que la función lee y escribe la base.
//                        Si no existe se usa SUPABASE_SERVICE_ROLE_KEY, que Supabase pone sola.
//   MOVIL_ORIGENES       opcional: direcciones permitidas de la app, separadas por comas
//                        (por ejemplo https://farmacia-inventario.pages.dev). Por defecto, todas.
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { crearManejador } from './manejador.mjs';

const url = Deno.env.get('SUPABASE_URL');
const llave = Deno.env.get('FARMACIA_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !llave) throw new Error('Faltan SUPABASE_URL o la llave secreta (FARMACIA_SECRET_KEY)');

const supabase = createClient(url, llave, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const origenesPermitidos = (Deno.env.get('MOVIL_ORIGENES') || '*')
  .split(',')
  .map((origen) => origen.trim().replace(/\/+$/, ''))
  .filter(Boolean);

Deno.serve(crearManejador({ supabase, origenesPermitidos }));
