/**
 * Jarvis reasoning — parts search (Phase 3a: deep links, no external fetch).
 *
 * Builds ready-made search links on the two ways staff actually buy parts:
 *   - Amazon         — usually cheapest/fastest for COMMON parts
 *   - PartSelect     — OEM/model-specific catalog; pricier but finds almost anything
 *   - RepairClinic   — specialist OEM, model-matched
 *
 * This does NOT fetch prices or availability — it returns links only (matches the
 * "a link would be great" goal). Phase 3b can add a paid search API for real
 * cheapest-price ranking. Tool gateway rule (JARVIS_SPINE Layer 5): read-only,
 * never auto-purchase.
 *
 * Link templates are best-effort and intentionally robust:
 *   - Amazon: stable `/s?k=` search.
 *   - PartSelect: canonical model page `/Models/<MODEL>/` when a model is known
 *     (the pro workflow), else a site-scoped Google search.
 *   - RepairClinic: site-scoped Google search (no stable public search param).
 */

function clean(s) {
  return String(s || "").trim();
}

function enc(s) {
  return encodeURIComponent(String(s || "").trim());
}

function joinQuery(parts) {
  return parts.map(clean).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function siteSearchUrl(query, site) {
  return "https://www.google.com/search?q=" + enc(query + " site:" + site);
}

/**
 * Pure link builder (no I/O) — exported for tests.
 * @param {{ make?: string, model?: string, part?: string, applianceType?: string }} o
 */
function buildPartsLinks(o) {
  const make = clean(o.make);
  const model = clean(o.model);
  const part = clean(o.part);
  const applianceType = clean(o.applianceType);

  // Amazon: precise OEM query (make + model + part), good for common parts.
  const amazonQuery = joinQuery([make, model, applianceType, part]);
  const amazon = {
    name: "Amazon",
    kind: "marketplace",
    url: "https://www.amazon.com/s?k=" + enc(amazonQuery),
    note: "Usually cheapest/fastest for common parts.",
  };

  // PartSelect: land on the model's OEM parts catalog when we know the model.
  const partSelect = {
    name: "PartSelect",
    kind: "specialist",
    url: model
      ? "https://www.partselect.com/Models/" + enc(model) + "/"
      : siteSearchUrl(joinQuery([make, applianceType, part]), "partselect.com"),
    note: model
      ? "Opens this model's OEM parts catalog — finds almost anything; usually pricier."
      : "OEM/model-specific catalog — finds almost anything; usually pricier.",
  };

  const repairClinic = {
    name: "RepairClinic",
    kind: "specialist",
    url: siteSearchUrl(joinQuery([make, model, applianceType, part]), "repairclinic.com"),
    note: "Specialist OEM parts, model-matched.",
  };

  return { amazonQuery, sources: [amazon, partSelect, repairClinic] };
}

/**
 * Tool entrypoint (async to match the loop's tool dispatch).
 * @param {object} params — see PARTS_SEARCH_TOOL_SCHEMA
 */
async function searchParts(params) {
  const p = params || {};
  const model = clean(p.model);
  const part = clean(p.part);
  if (!model && !part) return { ok: false, error: "missing_part_query" };

  const { amazonQuery, sources } = buildPartsLinks(p);

  return {
    ok: true,
    query: {
      make: clean(p.make) || null,
      model: model || null,
      part: part || null,
      applianceType: clean(p.applianceType) || null,
      amazonQuery,
    },
    pricesFetched: false, // links only — do NOT state prices or claim "cheapest" as fact
    sources,
  };
}

/** OpenAI function-calling schema. */
const PARTS_SEARCH_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "search_parts",
    description:
      "Build search links to buy a replacement part, on Amazon (cheapest/fastest for common parts) and " +
      "specialists PartSelect/RepairClinic (pricier but find almost anything, model-specific OEM). Read-only. " +
      "Resolve the make/model with get_unit_assets first, then call this with the part needed. IMPORTANT: this " +
      "returns LINKS ONLY — it does not fetch prices, so never state a price or claim which source is cheapest " +
      "as fact; present the general tradeoff and let the user open the links. Never purchase anything.",
    parameters: {
      type: "object",
      properties: {
        make: { type: "string", description: "Brand, e.g. Whirlpool." },
        model: { type: "string", description: "Model number from the asset registry, e.g. WDT750SAKZ." },
        part: { type: "string", description: "The part needed, e.g. 'heating element', 'door gasket'." },
        applianceType: { type: "string", description: "Equipment type, e.g. dishwasher, refrigerator." },
      },
      additionalProperties: false,
    },
  },
};

module.exports = {
  searchParts,
  buildPartsLinks,
  PARTS_SEARCH_TOOL_SCHEMA,
};
