/**
 * Resolve portal property code for Jarvis create-ticket proposals.
 * All matching is database-driven (listPropertiesForMenu) — no hardcoded property names.
 */
const { getSupabase } = require("../../db/supabase");
const { listPropertiesForMenu } = require("../../dal/intakeSession");
const { resolvePortalPropertyCode } = require("../../brain/core/portalStructuredCreateDraft");
const {
  resolvePropertyFromDatabaseText,
  formatPropertyCatalogForJarvis,
} = require("./resolvePropertyFromDatabaseText");
const { emit } = require("../../logging/structuredLog");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient | null} sb
 */
async function loadPropertyMenu(sb) {
  if (!sb) return { known: new Set(), list: [] };
  const list = await listPropertiesForMenu();
  const known = new Set(
    list.map((p) => String(p.code || "").trim().toUpperCase()).filter(Boolean)
  );
  return { known, list };
}

/**
 * @param {string[]} hints
 * @param {{ known: Set<string>, list: object[] }} menu
 * @param {string} [searchText]
 */
function resolveFromHints(hints, menu, searchText) {
  const texts = [];
  for (const h of hints) {
    const raw = String(h || "").trim();
    if (raw) texts.push(raw);
  }
  const search = String(searchText || "").trim();
  if (search) texts.push(search);

  for (const raw of texts) {
    const code = resolvePortalPropertyCode(raw, menu.known, menu.list);
    if (code) return { ok: true, propertyCode: code, via: "strict_code" };
  }

  for (const raw of texts) {
    const match = resolvePropertyFromDatabaseText(raw, menu.list, menu.known);
    if (match.status === "RESOLVED" && match.property_code) {
      return {
        ok: true,
        propertyCode: match.property_code,
        via: match.reason || "database",
      };
    }
    if (match.status === "AMBIGUOUS" && match.candidates?.length) {
      const names = match.candidates
        .slice(0, 4)
        .map((c) => {
          const addr = c.address ? ` (${c.address})` : "";
          return `${c.display_name || c.property_code}${addr}`;
        })
        .join(", ");
      return {
        ok: false,
        error: "ambiguous_property",
        message: `Which property — ${names}?`,
        candidates: match.candidates,
      };
    }
  }

  return { ok: false, error: "missing_property" };
}

/**
 * @param {object} opts
 * @param {string} [opts.propertyHint]
 * @param {string} [opts.searchText]
 * @param {object} [opts.scope]
 * @param {object} [opts.pageContext]
 * @param {string} [opts.traceId]
 */
async function resolveJarvisPropertyForCreate(opts) {
  const sb = getSupabase();
  const menu = await loadPropertyMenu(sb);

  const hints = [
    opts.propertyHint,
    opts.scope?.anchor?.propertyCode,
    opts.pageContext?.propertyCode,
    opts.pageContext?.property_code,
  ];

  const resolved = resolveFromHints(hints, menu, opts.searchText);

  if (!resolved.ok) {
    emit({
      level: "info",
      trace_id: opts.traceId || null,
      log_kind: "jarvis_property_resolve",
      event: "create_property_unresolved",
      data: {
        error: resolved.error,
        property_hint: String(opts.propertyHint || "").slice(0, 80),
        search_text_len: String(opts.searchText || "").length,
        menu_count: menu.list.length,
        menu_codes: menu.list.slice(0, 12).map((p) => p.code),
      },
    });

    if (resolved.error === "ambiguous_property") {
      return {
        ok: false,
        error: resolved.error,
        message: resolved.message,
      };
    }

    const examples = menu.list
      .filter((p) => String(p.code || "").toUpperCase() !== "GLOBAL")
      .slice(0, 3)
      .map((p) => {
        const addr = String(p.address || "").trim();
        return addr ? `${p.code} or ${addr.split(",")[0]}` : String(p.code);
      })
      .join("; ");
    return {
      ok: false,
      error: "missing_property",
      message: examples
        ? `Could not match that property. Try a code, building name, or street address from the portfolio — e.g. ${examples}.`
        : "Need a property — say the code, building name, or street address, or open the property page first.",
    };
  }

  return { ok: true, propertyCode: resolved.propertyCode, menu };
}

module.exports = {
  loadPropertyMenu,
  resolveJarvisPropertyForCreate,
  resolveFromHints,
  formatPropertyCatalogForJarvis,
};
