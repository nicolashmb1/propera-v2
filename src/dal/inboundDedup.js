/**
 * Transport hygiene only — Twilio SMS/WhatsApp dedupe vs GAS CacheService SID layer.
 * No brain logic. Uses DB so multi-instance Cloud Run shares state.
 */

const crypto = require("crypto");
const { getSupabase } = require("../db/supabase");

const DEFAULT_TTL_SEC = 60 * 60; // 1h — mirrors GAS SID cache.put TTL after success

/**
 * @param {string} from
 * @param {string} body
 */
function nosidDigest(from, body) {
  const fromNorm = String(from || "").trim().toLowerCase();
  const bodyTrim = String(body || "").trim();
  return (
    "NOSID:" +
    crypto
      .createHash("sha256")
      .update(`${fromNorm}|${bodyTrim}`, "utf8")
      .digest("hex")
      .slice(0, 32)
  );
}

/**
 * GAS-shaped inbound key: SID:SMS:… / SID:WA:… (ThreadId / finalize dedupe parity).
 * @param {{ messageSid?: string, from?: string, body?: string }} o
 * @returns {{ key: string, channel: 'SMS'|'WA' }}
 */
function buildInboundKey(o) {
  const fromNorm = String(o && o.from != null ? o.from : "").trim().toLowerCase();
  const bodyTrim = String(o && o.body != null ? o.body : "").trim();
  const sidRaw = String(o && o.messageSid != null ? o.messageSid : "").trim();
  const sidSafe = sidRaw ? sidRaw : nosidDigest(fromNorm, bodyTrim);
  const channel = fromNorm.startsWith("whatsapp:") ? "WA" : "SMS";
  return { key: `SID:${channel}:${sidSafe}`, channel };
}

/**
 * Prior successful commit still valid (not expired).
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function isSeen(key) {
  const k = String(key || "").trim();
  if (!k) return false;
  const sb = getSupabase();
  if (!sb) return false;

  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from("inbound_dedup")
    .select("id")
    .eq("dedup_key", k)
    .gt("expires_at", nowIso)
    .maybeSingle();

  if (error) return false;
  return !!data;
}

/**
 * Call only after a successful pipeline run (GAS: cache SID in finally when !hadError).
 * @param {string} key
 * @param {'SMS'|'WA'} channel
 * @param {number} [ttlSec]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function commitSeen(key, channel, ttlSec) {
  const k = String(key || "").trim();
  const ch = channel === "WA" ? "WA" : "SMS";
  const ttl = ttlSec != null && isFinite(Number(ttlSec)) ? Number(ttlSec) : DEFAULT_TTL_SEC;
  if (!k) return { ok: false, error: "missing_key" };

  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const { error } = await sb.from("inbound_dedup").upsert(
    {
      dedup_key: k,
      channel: ch,
      expires_at: expiresAt,
    },
    { onConflict: "dedup_key", ignoreDuplicates: true }
  );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = {
  buildInboundKey,
  nosidDigest,
  isSeen,
  commitSeen,
  DEFAULT_TTL_SEC,
};
