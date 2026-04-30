/**
 * Supabase client — optional; /health reports db when configured.
 * Uses service role on the server only (never expose to browsers).
 */
const { createClient } = require("@supabase/supabase-js");
const { supabaseUrl, supabaseServiceRoleKey } = require("../config/env");

let _client = null;
/** @type {import("@supabase/supabase-js").SupabaseClient | null | undefined} */
let _injectedClient = undefined;

/**
 * Integration tests only: inject a mock client before any `getSupabase()` call.
 * Requires `PROPERA_TEST_INJECT_SB=1` (set in `staffCaptureCrossChannel.integration.test.js` only).
 * @param {import("@supabase/supabase-js").SupabaseClient | null} client
 */
function setSupabaseClientForTests(client) {
  if (process.env.PROPERA_TEST_INJECT_SB !== "1") {
    throw new Error("setSupabaseClientForTests: set PROPERA_TEST_INJECT_SB=1");
  }
  _injectedClient = client;
}

function clearSupabaseClientForTests() {
  _injectedClient = undefined;
}

function getSupabase() {
  if (process.env.PROPERA_TEST_INJECT_SB === "1" && _injectedClient !== undefined) {
    return _injectedClient;
  }
  if (!supabaseUrl || !supabaseServiceRoleKey) return null;
  if (!_client) {
    _client = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}

function isDbConfigured() {
  if (process.env.PROPERA_TEST_INJECT_SB === "1" && _injectedClient != null) {
    return true;
  }
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

module.exports = {
  getSupabase,
  isDbConfigured,
  pingDb,
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
};
