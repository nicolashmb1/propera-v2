/**
 * GAS `extractStaffTenantNameHintFromText_` — `16_ROUTER_ENGINE.gs` ~2515–2536
 * + **leading** name hint (e.g. `#Maria report from 101 westfield…` → `Maria`) for staff #capture stripped body.
 */

function normalizeName_(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * GAS `scoreNameMatch_` — `14_DIRECTORY_SESSION_DAL.gs` ~2197–2205
 */
function scoreNameMatch_(queryName, rowName) {
  const q = normalizeName_(queryName);
  const r = normalizeName_(rowName);
  if (!q || !r) return 0;
  if (q === r) return 100;
  if (r.startsWith(q) || q.startsWith(r)) return 85;
  if (r.includes(q) || q.includes(r)) return 70;
  return 0;
}

/**
 * GAS tail-segment name (after punctuation).
 */
function extractStaffTenantNameHintFromText_(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const parts = raw.split(/[.;,\n]/);
  let tail = String(parts.length ? parts[parts.length - 1] : raw).trim();
  if (!tail) tail = raw;

  tail = tail.replace(/^\s*(tenant|name|for|resident)\s*[:\-]?\s*/i, "").trim();
  tail = tail.replace(/^\s*(tenant|resident)\s+is\s+/i, "").trim();
  tail = tail.replace(/[()"'`]/g, "").trim();
  if (!tail) return "";

  if (tail.length < 2 || tail.length > 40) return "";
  if (/\d/.test(tail)) return "";
  if (!/^[A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*)?$/.test(tail))
    return "";
  if (
    /\b(leak|leaking|broken|not working|flicker|flickering|clog|smell|noise|light|sink|toilet|heater|ac|heat|kitchen|bathroom)\b/i.test(
      tail
    )
  )
    return "";

  return tail;
}

/**
 * Leading personal name before verbs like "report" / "says" (staff capture body after `#` strip).
 */
function extractLeadingStaffTenantNameHint_(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const m = raw.match(
    /^([A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*)?)\s+(?=report\b|says\b|said\b|called\b|texted\b|told\b|mentioned\b)/i
  );
  if (!m) return "";
  const cand = String(m[1] || "").trim();
  if (cand.length < 2 || cand.length > 40) return "";
  if (/\d/.test(cand)) return "";
  return cand;
}

function extractStaffTenantNameHintCombined(text) {
  const lead = extractLeadingStaffTenantNameHint_(text);
  if (lead) return lead;
  return extractStaffTenantNameHintFromText_(text);
}

module.exports = {
  normalizeName_,
  scoreNameMatch_,
  extractStaffTenantNameHintFromText_,
  extractLeadingStaffTenantNameHint_,
  extractStaffTenantNameHintCombined,
};
