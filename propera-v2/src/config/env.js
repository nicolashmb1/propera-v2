/**
 * Central env read — fail soft in dev so `npm start` works with zero secrets.
 */
require("dotenv").config();

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

module.exports = {
  nodeEnv: env("NODE_ENV", "development"),
  port: parseInt(env("PORT", "8080"), 10) || 8080,
  supabaseUrl: env("SUPABASE_URL", ""),
  supabaseServiceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY", ""),
};
