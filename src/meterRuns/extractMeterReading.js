/**
 * Vision extraction for utility meter photos — facts only; Propera validates downstream.
 * Two-phase batch flow (see meterBillingRuns): match pass → refinement pass with previousReading + expected context.
 */
const { openaiApiKey, openaiModelMeterBatch } = require("../config/env");

/**
 * @returns {object}
 */
function stubExtraction() {
  return {
    meterLabel: null,
    qrValue: null,
    rawDisplay: null,
    finalReading: null,
    confidence: "low",
    highPlaceDigitsReliable: false,
    possibleReadings: [],
    uncertainDigits: [],
    qualityFlags: [],
    needsReviewHint: true,
    extractor: "stub",
    digits: [],
    reviewReason: null,
  };
}

/**
 * @param {string} text
 * @returns {object|null}
 */
function safeJsonParse(text) {
  try {
    const t = String(text || "").trim();
    if (!t) return null;
    return JSON.parse(t);
  } catch (_) {
    return null;
  }
}

/**
 * @param {{
 *   previousReading?: number|null,
 *   expectedRegisterDigitCount?: number|null,
 *   lastDigitMustBeZero?: boolean,
 *   qrDecodedHint?: string|null,
 *   expectedMeterId?: string|null,
 *   refinementPass?: boolean,
 * }} opts
 */
function buildMeterExtractionPrompt(opts) {
  const prev =
    opts.previousReading != null && opts.previousReading !== "" && Number.isFinite(Number(opts.previousReading))
      ? Math.round(Number(opts.previousReading))
      : null;

  const expDigits =
    opts.expectedRegisterDigitCount != null && Number.isFinite(Number(opts.expectedRegisterDigitCount))
      ? Math.round(Number(opts.expectedRegisterDigitCount))
      : null;

  const lastZero = opts.lastDigitMustBeZero === true;
  const qrHint = opts.qrDecodedHint ? String(opts.qrDecodedHint).trim() : "";
  const expectedId = opts.expectedMeterId ? String(opts.expectedMeterId).trim() : "";
  const refinement = opts.refinementPass === true;

  const prevBlock =
    prev != null
      ? `
Billing safety — previous period reading for THIS meter: ${prev}.
- finalReading should usually be >= ${prev} unless rollover/replacement/meter reset.
- If your reading implies a huge jump, backwards usage, or an extra leading digit vs the wheels, RECOUNT left-to-right on the odometer strip only — do not merge QR/serial/auxiliary text into the register value.
`
      : "";

  const contextBlock = `
Expected context (trust these for consistency checks; still verify visually):
${expectedId ? `- Confirmed meter ID for this photo (registry match): "${expectedId}". Align meterLabel/qrValue with this when visible.` : "- Meter ID: infer from stencil/QR as usual."}
${expDigits != null ? `- Expected visible billing register digit positions (wheels/LCD width): ${expDigits}. If you count fewer or more, set needsReviewHint=true and explain in qualityFlags.` : ""}
${lastZero ? "- Portfolio rule: billed reading ends in 0 (whole tens). rawDisplay must include every wheel including trailing 0; finalReading MUST end in 0." : ""}
${qrHint ? `- Programmatic QR decode hint (may be wrong on glare/crops): "${qrHint.slice(0, 120)}". Prefer stencil if QR unreadable in image.` : ""}
${refinement ? "- This is a REFINEMENT pass: focus on digit accuracy on the odometer strip; apply all safety rules strictly." : ""}
`;

  return `You transcribe utility meter photos for billing. Wrong digits are worse than flagging review.

Return ONLY valid JSON:
{
  "meterLabel": string or null,
  "qrValue": string or null,
  "rawDisplay": string or null (main odometer-style billing register only, left-to-right billing order; include leading zeros on wheels),
  "registerDigitCount": integer or null,
  "finalReading": integer or null,
  "confidence": "high"|"medium"|"low",
  "highPlaceDigitsReliable": boolean,
  "digits": [
    {
      "index": integer (0=leftmost billing digit),
      "digit": string (single character 0-9),
      "confidence": "high"|"medium"|"low",
      "ambiguousWith": string[] (alternate digits if uncertain, else [])
    }
  ],
  "possibleReadings": integer[],
  "qualityFlags": string[],
  "needsReviewHint": boolean,
  "reviewReason": string or null (short office-facing note when review needed)
}

Meter-specific reading rules:
- The billing register is the odometer-style digit wheel strip (or dominant LCD odometer line) ONLY.
- IGNORE for rawDisplay/finalReading: red sweep hands, round gauges, pointer needles, manufacturer/serial text, decorative stickers, QR/barcode payload unless it is clearly duplicate of stencil — still prefer wheels for the numeric reading.
- Register may be rotated in the photo; read wheels in natural billing order (typically left-to-right as printed).
- Critical billing safety: early/high-place digits matter most. If a digit could be confused (e.g. 1/7, 6/8/5, 4/9) or is partially hidden, do NOT guess — needsReviewHint=true and populate ambiguousWith + possibleReadings.
- If glare, pointer, shadow, screw head, or cover edge crosses a digit window, add qualityFlags including "digit_obstruction".
- Do not set confidence high unless digit certainty warrants it — sharp photo ≠ readable digit.

JSON discipline:
- digits array: one entry per visible billing digit position left-to-right; omit trailing entirely only if truly unreadable (then needsReviewHint=true).
- possibleReadings: include plausible integers when ambiguous.

${contextBlock}
${prevBlock}`;
}

/**
 * @param {Buffer} imageBuf
 * @param {string} mimeType
 * @param {{
 *   previousReading?: number|null,
 *   expectedRegisterDigitCount?: number|null,
 *   lastDigitMustBeZero?: boolean,
 *   qrDecodedHint?: string|null,
 *   expectedMeterId?: string|null,
 *   refinementPass?: boolean,
 * }} [opts]
 * @returns {Promise<object>}
 */
async function extractMeterReadingFromImage(imageBuf, mimeType, opts = {}) {
  const key = openaiApiKey();
  if (!key || !imageBuf || imageBuf.length === 0) {
    return stubExtraction();
  }

  const model = openaiModelMeterBatch();
  const b64 = imageBuf.toString("base64");
  const dataUrl = `data:${mimeType || "image/jpeg"};base64,${b64}`;

  const prompt = buildMeterExtractionPrompt(opts);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const out = stubExtraction();
    out.extractor = "openai_error";
    out.qualityFlags = ["openai_http_error"];
    out.extractError = `${res.status}: ${errText.slice(0, 200)}`;
    out.needsReviewHint = true;
    return out;
  }

  const data = await res.json().catch(() => null);
  const content = data && data.choices && data.choices[0] && data.choices[0].message;
  const txt = content && content.content ? String(content.content) : "";
  const parsed = safeJsonParse(txt);
  if (!parsed || typeof parsed !== "object") {
    const out = stubExtraction();
    out.extractor = "openai_parse_error";
    out.qualityFlags = ["openai_bad_json"];
    return out;
  }

  const merged = {
    ...stubExtraction(),
    ...parsed,
    extractor: "openai",
  };

  if (!Array.isArray(merged.possibleReadings)) merged.possibleReadings = [];
  if (!Array.isArray(merged.qualityFlags)) merged.qualityFlags = [];
  if (!Array.isArray(merged.digits)) merged.digits = [];

  merged.digits = merged.digits
    .filter((d) => d && typeof d === "object")
    .map((d) => ({
      index: Number.isFinite(Number(d.index)) ? Math.round(Number(d.index)) : 0,
      digit: String(d.digit != null ? d.digit : "").replace(/\D/g, "").slice(0, 1) || "?",
      confidence: String(d.confidence || "medium").toLowerCase(),
      ambiguousWith: Array.isArray(d.ambiguousWith)
        ? d.ambiguousWith.map((x) => String(x).replace(/\D/g, "").slice(0, 1)).filter(Boolean)
        : [],
    }));

  if (merged.registerDigitCount != null) {
    const d = Number(merged.registerDigitCount);
    merged.registerDigitCount = Number.isFinite(d) ? Math.round(d) : null;
  }

  if (merged.finalReading != null) {
    const n = Number(merged.finalReading);
    merged.finalReading = Number.isFinite(n) ? Math.round(n) : null;
  }

  merged.possibleReadings = merged.possibleReadings
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x))
    .map((x) => Math.round(x));

  const rawDisp = String(merged.rawDisplay || "");
  const rawDigits = rawDisp.replace(/\D/g, "");

  /** Extra leading digit vs rawDisplay (e.g. 980170 vs raw "80170"). */
  if (
    merged.finalReading != null &&
    !rawDisp.includes(".") &&
    /^[0-9]+$/.test(rawDigits) &&
    rawDigits.length >= 4
  ) {
    const cur = Math.round(Number(merged.finalReading));
    const s = String(Math.abs(cur));
    if (s.length === rawDigits.length + 1 && s.slice(1) === rawDigits) {
      merged.finalReading = Number(rawDigits);
      merged.qualityFlags.push("leading_digit_stripped_match_raw");
    }
  }

  /** Post-process numeric tens correction — caller passes explicit flag from env on both passes. */
  const wholeTens = opts.lastDigitMustBeZero === true;
  if (wholeTens && merged.finalReading != null) {
    let r = Math.round(Number(merged.finalReading));
    const cnt =
      merged.registerDigitCount != null && Number.isFinite(Number(merged.registerDigitCount))
        ? Math.round(Number(merged.registerDigitCount))
        : null;
    const len = String(Math.abs(r)).length;
    if (r % 10 !== 0 && cnt != null && len === cnt - 1) {
      merged.finalReading = r * 10;
      merged.qualityFlags.push("whole_tens_appended_zero");
    } else if (r % 10 !== 0 && cnt != null && len < cnt) {
      let next = r;
      let guard = 0;
      while (next % 10 !== 0 && String(Math.abs(next)).length < cnt && guard < 4) {
        next *= 10;
        guard += 1;
      }
      if (next % 10 === 0 && String(Math.abs(next)).length <= cnt) {
        merged.finalReading = next;
        merged.qualityFlags.push("whole_tens_scaled_to_digit_count");
      }
    }
  }

  if (
    merged.finalReading != null &&
    !rawDisp.includes(".") &&
    rawDigits.length >= 4 &&
    /^[0-9]+$/.test(rawDigits)
  ) {
    const fromRaw = Number(rawDigits.replace(/^0+/, "") || "0");
    const alt = Number(rawDigits);
    const cur = merged.finalReading;
    if (Number.isFinite(fromRaw) && Number.isFinite(alt)) {
      const matchRaw = cur === alt || cur === fromRaw;
      if (!matchRaw && (String(cur).length !== rawDigits.length || Math.abs(cur - alt) > 9)) {
        merged.qualityFlags.push("finalReading_rawDisplay_mismatch");
        merged.needsReviewHint = true;
        if (merged.confidence === "high") merged.confidence = "medium";
      }
    }
  }

  if (wholeTens && merged.finalReading != null && merged.finalReading % 10 !== 0) {
    merged.needsReviewHint = true;
    merged.qualityFlags.push("whole_tens_expected_last_digit_zero");
  }

  return merged;
}

module.exports = { extractMeterReadingFromImage, stubExtraction, buildMeterExtractionPrompt };
