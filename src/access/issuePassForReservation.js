const { getSupabase } = require("../db/supabase");
const { encryptCredentialValue } = require("./credentialCrypto");
const { getLockAdapter } = require("./lockAdapter/getLockAdapter");

/**
 * Issue or re-issue pass for a reservation (noop pilot: immediate PIN).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} reservation
 * @param {object} lockRow
 * @param {string} [actor]
 */
async function issuePassForReservation(sb, reservation, lockRow, actor = "") {
  const adapter = getLockAdapter(lockRow.provider);
  const validFrom = new Date(reservation.start_at);
  const validUntil = new Date(reservation.end_at);
  const issued = await adapter.issueCredential(lockRow, validFrom, validUntil);
  const enc = encryptCredentialValue(issued.credentialValue);

  const { data: pass, error: passErr } = await sb
    .from("access_passes")
    .insert({
      reservation_id: reservation.id,
      lock_id: lockRow.id,
      credential_type: issued.credentialType || "pin",
      credential_value_enc: enc,
      valid_from: validFrom.toISOString(),
      valid_until: validUntil.toISOString(),
      status: "ISSUED",
      issued_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (passErr || !pass) {
    throw new Error(passErr?.message || "pass_insert_failed");
  }

  await sb
    .from("access_reservations")
    .update({
      access_pass_id: pass.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservation.id);

  return { pass, pin: issued.credentialValue };
}

module.exports = { issuePassForReservation };
