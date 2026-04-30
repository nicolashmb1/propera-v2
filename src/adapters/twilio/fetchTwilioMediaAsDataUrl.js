/**
 * GAS `fetchTwilioMediaAsDataUrl_` — Basic auth download → `data:image/...;base64,...`.
 */

const ALLOWED = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

function normalizeImageMime(mimeRaw, hinted) {
  let m = String(mimeRaw || "")
    .trim()
    .toLowerCase()
    .split(";")[0];
  const hint = String(hinted || "")
    .trim()
    .toLowerCase()
    .split(";")[0];
  if (m === "image/jpg" || m === "image/pjpeg" || m === "image/jfif") m = "image/jpeg";
  let h = hint;
  if (h === "image/jpg" || h === "image/pjpeg" || h === "image/jfif") h = "image/jpeg";
  if (!m || m === "application/octet-stream") {
    if (h && ALLOWED.has(h)) return h;
  }
  if (ALLOWED.has(m)) return m;
  if (h && ALLOWED.has(h)) return h;
  return "";
}

/**
 * @param {string} mediaUrl — Twilio MediaUrl*
 * @param {string} accountSid
 * @param {string} authToken
 * @param {string} [hintedContentType] — from webhook MediaContentType*
 */
async function fetchTwilioMediaAsDataUrl(
  mediaUrl,
  accountSid,
  authToken,
  hintedContentType
) {
  const url = String(mediaUrl || "").trim();
  const sid = String(accountSid || "").trim();
  const token = String(authToken || "").trim();
  if (!url || !sid || !token) return "";

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return "";

  const mimeHeader = res.headers.get("content-type") || "";
  const mime = normalizeImageMime(mimeHeader, hintedContentType);
  if (!mime) return "";

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf || buf.length < 8) return "";

  return `data:${mime};base64,${buf.toString("base64")}`;
}

module.exports = { fetchTwilioMediaAsDataUrl, normalizeImageMime };
