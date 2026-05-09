/**
 * Idempotent import of GAS-style Units sheet (tab-separated) into public.units.
 *
 * Expected header row (columns may be in any order):
 *   UnitID, PropertyID, UnitLabel, Floor, Bedrooms, Bathrooms, Status, Notes, CreatedAt, UnitKey
 *
 * PropertyID like PROP_PENN → property_code PENN (strip leading PROP_ case-insensitive).
 *
 * Usage (from propera-v2, with .env containing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY):
 *   node scripts/import-units-from-sheet-tsv.js path/to/units.tsv
 *
 * @see supabase/migrations/030_units_catalog_and_portal_views.sql
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const REQUIRED = ["propertyid", "unitlabel"];

function splitTsvLine(line) {
  const out = [];
  let cur = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "\t") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  out.push(cur);
  return out;
}

function propertyCodeFromPropertyId(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^PROP_(.+)$/i);
  if (m) return m[1].toUpperCase();
  return s.toUpperCase();
}

function parseFile(content) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitTsvLine(lines[0]).map((h) => h.trim());
  const idx = Object.fromEntries(headers.map((h, i) => [h.toLowerCase().replace(/\s+/g, ""), i]));
  for (const k of REQUIRED) {
    if (idx[k] === undefined) {
      throw new Error(`Missing column (case-insensitive): ${k}. Found: ${headers.join(", ")}`);
    }
  }
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = splitTsvLine(lines[li]);
    const get = (key) => {
      const i = idx[key];
      return i === undefined ? "" : String(cols[i] ?? "").trim();
    };
    const propertyCode = propertyCodeFromPropertyId(get("propertyid"));
    const unitLabel = get("unitlabel");
    if (!propertyCode || !unitLabel) continue;
    rows.push({
      property_code: propertyCode,
      unit_label: unitLabel,
      floor: get("floor"),
      bedrooms: get("bedrooms"),
      bathrooms: get("bathrooms"),
      status: get("status") || "Vacant",
      notes: get("notes"),
      legacy_gas_unit_id: get("unitid") || null,
      unit_key: get("unitkey") || null,
    });
  }
  return { headers, rows };
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error("Usage: node scripts/import-units-from-sheet-tsv.js <path-to.tsv>");
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(abs)) {
    console.error("File not found:", abs);
    process.exit(1);
  }
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }
  const content = fs.readFileSync(abs, "utf8");
  const { rows } = parseFile(content);
  console.log(`Parsed ${rows.length} unit rows`);

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const batch = 200;
  let ok = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const { error } = await sb.from("units").upsert(chunk, {
      onConflict: "property_code,unit_label",
    });
    if (error) {
      console.error("Upsert error at batch", i, error.message);
      process.exit(1);
    }
    ok += chunk.length;
    console.log(`Upserted ${ok}/${rows.length}`);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
