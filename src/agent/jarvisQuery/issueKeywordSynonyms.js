/**
 * Issue keyword synonyms for service history search (read-only analytics).
 */

/** @type {Record<string, string[]>} */
const ISSUE_SYNONYMS = {
  refrigerator: ["refrigerator", "fridge", "refrig", "freezer"],
  fridge: ["fridge", "refrigerator", "refrig", "freezer"],
  freezer: ["freezer", "refrigerator", "fridge"],
  dishwasher: ["dishwasher", "dish washer"],
  icemaker: ["icemaker", "ice maker", "ice-maker"],
  microwave: ["microwave"],
  oven: ["oven", "stove", "range"],
  stove: ["stove", "oven", "range", "burner"],
  heat: ["heat", "heating", "heater", "furnace", "boiler", "radiator"],
  ac: ["ac", "a/c", "air condition", "cooling", "hvac"],
  hvac: ["hvac", "heat", "ac", "air condition"],
  leak: ["leak", "leaking", "drip", "water damage"],
  toilet: ["toilet", "commode"],
  sink: ["sink", "faucet", "tap"],
  plumbing: ["plumbing", "pipe", "drain", "clog"],
  electrical: ["electrical", "electric", "outlet", "breaker", "power"],
  lock: ["lock", "deadbolt", "key"],
  door: ["door", "entry"],
  window: ["window"],
  pest: ["pest", "roach", "mouse", "bedbug", "bed bug"],
};

const STOP_WORDS = new Set([
  "how",
  "many",
  "much",
  "the",
  "a",
  "an",
  "at",
  "for",
  "all",
  "any",
  "we",
  "had",
  "have",
  "were",
  "there",
  "issue",
  "issues",
  "ticket",
  "tickets",
  "service",
  "services",
  "problem",
  "problems",
  "last",
  "past",
  "over",
  "during",
  "in",
  "this",
  "property",
  "portfolio",
  "company",
  "did",
  "was",
  "were",
  "about",
  "maker",
  "ice",
]);

/**
 * @param {string} phrase
 * @returns {string[]}
 */
function expandIssueKeywords(phrase) {
  const raw = String(phrase || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s/-]/g, " ");
  const normalized = raw.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  if (/ice\s*maker|icemaker/.test(normalized.replace(/\s/g, ""))) {
    return ["icemaker", "ice maker"];
  }

  const compactPhrase = normalized.replace(/\s+/g, " ");
  const phraseSyns = ISSUE_SYNONYMS[compactPhrase];
  if (phraseSyns) return [...new Set(phraseSyns)];

  const nospace = compactPhrase.replace(/\s/g, "");
  const nospaceSyns = ISSUE_SYNONYMS[nospace];
  if (nospaceSyns) return [...new Set(nospaceSyns)];

  const tokens = compactPhrase.split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  if (!tokens.length) return [];

  const out = new Set();
  for (const token of tokens) {
    out.add(token);
    const syns = ISSUE_SYNONYMS[token];
    if (syns) {
      for (const s of syns) out.add(s);
    }
  }

  const joined = tokens.join(" ");
  if (joined.length > 4) out.add(joined);

  return Array.from(out);
}

module.exports = { ISSUE_SYNONYMS, expandIssueKeywords, STOP_WORDS };
