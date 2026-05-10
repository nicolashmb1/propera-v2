/**
 * Deterministic reading status (MVP 1a — usage/reading gates; no dollar variance until policy exists).
 * @param {object} input
 * @param {bigint|number|null|undefined} input.previousReading
 * @param {bigint|number|null|undefined} input.currentReading
 * @param {object|null|undefined} input.extraction
 * @returns {{ status: string, reviewReasons: string[], usage: number|null }}
 */
function validateMeterReading(input) {
  const prev =
    input.previousReading != null && input.previousReading !== ""
      ? Number(input.previousReading)
      : null;
  const cur =
    input.currentReading != null && input.currentReading !== ""
      ? Number(input.currentReading)
      : null;

  const extraction = input.extraction && typeof input.extraction === "object" ? input.extraction : {};

  const reasons = [];

  if (cur == null || !Number.isFinite(cur)) {
    return { status: "MISSING", reviewReasons: ["no_current_reading"], usage: null };
  }

  let usage = null;
  if (prev != null && Number.isFinite(prev)) {
    usage = Math.round(cur - prev);
    if (usage < 0) reasons.push("negative_usage");
    else if (
      prev >= 50 &&
      usage != null &&
      Number.isFinite(usage) &&
      usage > Math.max(prev * 10, 250000)
    ) {
      reasons.push("usage_jump_vs_previous");
    }
  }

  if (extraction.needsReviewHint === true) {
    reasons.push("extractor_needs_review");
  }

  const conf = String(extraction.confidence || "").toLowerCase();
  if (conf === "low") {
    reasons.push("low_confidence");
  }

  const possible = Array.isArray(extraction.possibleReadings)
    ? extraction.possibleReadings.map((x) => Number(x)).filter((x) => Number.isFinite(x))
    : [];
  if (possible.length > 1) {
    const mn = Math.min(...possible);
    const mx = Math.max(...possible);
    if (mx !== mn) reasons.push("ambiguous_possible_readings");
  }

  const digits = Array.isArray(extraction.digits) ? extraction.digits : [];
  if (digits.length > 0) {
    const mid = Math.max(1, Math.floor(digits.length / 2));
    for (let i = 0; i < mid; i++) {
      const d = digits[i];
      if (!d || typeof d !== "object") continue;
      const amb = Array.isArray(d.ambiguousWith) && d.ambiguousWith.length > 0;
      const c = String(d.confidence || "").toLowerCase();
      if (amb || c === "low") {
        reasons.push("high_place_digit_uncertain");
        break;
      }
    }
  }

  if (reasons.length > 0) {
    return { status: "CHECK_PHOTO", reviewReasons: reasons, usage };
  }

  return { status: "AUTO_ACCEPTED", reviewReasons: [], usage };
}

module.exports = { validateMeterReading };
