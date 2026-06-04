/**
 * Dedupe keys for Jarvis create_service_request — same unit, different issues allowed.
 */

const ISSUE_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "not",
  "working",
  "broken",
  "issue",
  "problem",
]);

/**
 * @param {string} text
 */
function normalizeIssueKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function issueTokens(text) {
  const out = new Set();
  for (const raw of normalizeIssueKey(text).split(" ")) {
    const t = String(raw || "").trim();
    if (!t || ISSUE_STOP_WORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * @param {string} a
 * @param {string} b
 */
function issuesAreDuplicate(a, b) {
  const ka = normalizeIssueKey(a);
  const kb = normalizeIssueKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;

  const ta = issueTokens(a);
  const tb = issueTokens(b);
  if (!ta.size || !tb.size) return false;

  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
  }
  const union = new Set([...ta, ...tb]).size;
  if (union > 0 && inter / union >= 0.85) return true;

  const shorter = ka.length <= kb.length ? ka : kb;
  const longer = ka.length <= kb.length ? kb : ka;
  if (longer.includes(shorter) && shorter.length >= 8) {
    return shorter.length / longer.length >= 0.55;
  }
  return false;
}

module.exports = { normalizeIssueKey, issueTokens, issuesAreDuplicate };
