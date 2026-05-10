/**
 * Try to decode a QR code from an image buffer (JPEG/PNG only). Vision path remains fallback.
 */
function tryDecodeQrFromImageBuffer(buf, mimeType) {
  if (!buf || buf.length < 64) return null;
  const m = String(mimeType || "image/jpeg").toLowerCase().split(";")[0].trim();

  try {
    let width;
    let height;
    /** @type {Uint8Array|Buffer} */
    let rgba;

    if (m === "image/jpeg" || m === "image/jpg") {
      const jpeg = require("jpeg-js");
      const raw = jpeg.decode(buf, { useTArray: true });
      if (!raw || !raw.data || raw.width < 16 || raw.height < 16) return null;
      width = raw.width;
      height = raw.height;
      rgba = raw.data;
    } else if (m === "image/png") {
      const { PNG } = require("pngjs");
      const png = PNG.sync.read(buf);
      width = png.width;
      height = png.height;
      rgba = png.data;
    } else {
      return null;
    }

    const jsQR = require("jsqr");
    const code = jsQR(new Uint8ClampedArray(rgba), width, height, { inversionAttempts: "attemptBoth" });
    if (!code || !code.data) return null;
    const text = String(code.data).trim();
    return text.length ? text : null;
  } catch (_) {
    return null;
  }
}

module.exports = { tryDecodeQrFromImageBuffer };
