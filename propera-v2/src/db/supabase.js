/**
 * Supabase client — optional; /health reports db when configured.
 * Uses service role on the server only (never expose to browsers).
 */
const { createClient } = require("@supabase/supabase-js");
const { supabaseUrl, supabaseServiceRoleKey } = require("../config/env");

let _client = null;

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceRoleKey) return null;
  if (!_client) {
    _client = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}

function isDbConfigured() {
  return !!(supabaseUrl && supabaseServiceRoleKey);
}

/**
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function pingDb() {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "not_configured" };
  const { error } = await sb.from("conversation_ctx").select("phone_e164").limit(1);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = { getSupabase, isDbConfigured, pingDb };
