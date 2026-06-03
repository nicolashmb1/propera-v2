/**
 * Resident portal document reads — tenant_roster + unit scope.
 * Staff uploads live in propera-app (Supabase service role).
 */

const { tenantDocsBucket } = require("../config/env");

const DOC_TYPES = new Set(["LEASE", "ADDENDUM", "BUILDING_RULES", "NOTICE", "OTHER"]);

const SIGNED_URL_TTL_SEC = 15 * 60;

function mapDocRow(row) {
  return {
    id: String(row.id),
    name: String(row.name || "").trim(),
    docType: String(row.doc_type || "OTHER").trim(),
    fileSizeBytes: row.file_size_bytes != null ? Number(row.file_size_bytes) : null,
    mimeType: String(row.mime_type || "").trim() || null,
    createdAt: row.created_at || null,
  };
}

/**
 * List documents visible to the logged-in tenant (roster row or same unit).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ tenantId: string, unitId?: string }} ctx
 */
async function listTenantDocuments(sb, ctx) {
  const tenantId = String(ctx.tenantId || "").trim();
  const unitId = String(ctx.unitId || "").trim();
  if (!tenantId) return { ok: false, error: "missing_tenant_context" };

  let query = sb
    .from("tenant_documents")
    .select("id, name, doc_type, file_size_bytes, mime_type, created_at, storage_path, tenant_roster_id")
    .eq("visible_to_tenant", true)
    .order("created_at", { ascending: false });

  if (unitId) {
    query = query.or(`tenant_roster_id.eq.${tenantId},unit_id.eq.${unitId}`);
  } else {
    query = query.eq("tenant_roster_id", tenantId);
  }

  const { data, error } = await query;
  if (error) return { ok: false, error: error.message };

  const seen = new Set();
  const documents = [];
  for (const row of data || []) {
    const path = String(row.storage_path || "").trim();
    const key = path || String(row.id);
    if (seen.has(key)) continue;
    seen.add(key);
    documents.push(mapDocRow(row));
  }
  return { ok: true, documents };
}

/**
 * Signed download URL — tenant must own doc via roster or unit.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ tenantId: string, unitId?: string }} ctx
 * @param {string} documentId
 */
async function getTenantDocumentDownloadUrl(sb, ctx, documentId) {
  const tenantId = String(ctx.tenantId || "").trim();
  const unitId = String(ctx.unitId || "").trim();
  const docId = String(documentId || "").trim();
  if (!tenantId || !docId) return { ok: false, error: "missing_fields" };

  const { data: row, error } = await sb
    .from("tenant_documents")
    .select("id, tenant_roster_id, unit_id, storage_path, storage_bucket, visible_to_tenant, name, mime_type")
    .eq("id", docId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!row || !row.visible_to_tenant) return { ok: false, error: "not_found" };

  const rosterOk = String(row.tenant_roster_id) === tenantId;
  const unitOk = unitId && String(row.unit_id) === unitId;
  if (!rosterOk && !unitOk) return { ok: false, error: "not_found" };

  const bucket = String(row.storage_bucket || tenantDocsBucket()).trim();
  const path = String(row.storage_path || "").trim();
  if (!path) return { ok: false, error: "invalid_storage" };

  const { data: signed, error: signErr } = await sb.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SEC);

  if (signErr || !signed?.signedUrl) {
    return { ok: false, error: signErr?.message || "signed_url_failed" };
  }

  return {
    ok: true,
    url: signed.signedUrl,
    name: String(row.name || "").trim(),
    mimeType: String(row.mime_type || "").trim() || null,
    expiresInSec: SIGNED_URL_TTL_SEC,
  };
}

module.exports = {
  DOC_TYPES,
  listTenantDocuments,
  getTenantDocumentDownloadUrl,
};
