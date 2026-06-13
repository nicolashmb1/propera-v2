const { generatePin } = require("../credentialCrypto");
const { getSeamClient } = require("./seamClient");

/**
 * @param {unknown} row
 * @returns {{ accessCodeId: string, code: string }}
 */
const SEAM_ACCESS_CODE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSeamManagedCredentialId(externalCredentialId) {
  const id = String(externalCredentialId || "").trim();
  if (!id || id.startsWith("noop-")) return false;
  return SEAM_ACCESS_CODE_ID_RE.test(id);
}

function parseSeamAccessCode(row) {
  const ac = row && typeof row === "object" ? row : {};
  const nested =
    ac.access_code && typeof ac.access_code === "object" ? ac.access_code : ac;
  const accessCodeId = String(
    nested.access_code_id || ac.access_code_id || ""
  ).trim();
  const code = String(nested.code || ac.code || "").trim();
  return { accessCodeId, code };
}

const seamAdapter = {
  /**
   * @param {object} lockRow
   * @param {Date} validFrom
   * @param {Date} validUntil
   * @param {{ reservationId?: string, name?: string }} [ctx]
   */
  async issueCredential(lockRow, validFrom, validUntil, ctx = {}) {
    const deviceId = String(lockRow.external_lock_id || "").trim();
    if (!deviceId) throw new Error("seam_device_id_missing");

    const pin = generatePin();
    const label = String(ctx.name || ctx.reservationId || "propera-access").trim();
    const seam = getSeamClient();
    const created = await seam.accessCodes.create({
      device_id: deviceId,
      name: label.slice(0, 64),
      starts_at: validFrom.toISOString(),
      ends_at: validUntil.toISOString(),
      code: pin,
      prefer_native_scheduling: true,
    });

    const parsed = parseSeamAccessCode(created);
    if (!parsed.accessCodeId) {
      throw new Error("seam_access_code_id_missing");
    }

    return {
      credentialType: "pin",
      credentialValue: parsed.code || pin,
      validFrom,
      validUntil,
      externalCredentialId: parsed.accessCodeId,
    };
  },

  /**
   * @param {object} _lockRow
   * @param {{ externalCredentialId?: string }} [ctx]
   */
  async revokeCredential(_lockRow, ctx = {}) {
    const externalCredentialId = String(ctx.externalCredentialId || "").trim();
    if (!externalCredentialId) return { ok: true, skipped: true };
    if (!isSeamManagedCredentialId(externalCredentialId)) {
      return { ok: true, skipped: true, reason: "not_seam_credential" };
    }
    const seam = getSeamClient();
    await seam.accessCodes.delete({ access_code_id: externalCredentialId });
    return { ok: true };
  },

  async getStatus(lockRow) {
    const deviceId = String(lockRow.external_lock_id || "").trim();
    if (!deviceId) {
      return { online: false, provider: "seam", detail: "device_id_missing" };
    }
    try {
      const seam = getSeamClient();
      const device = await seam.devices.get({ device_id: deviceId });
      const online =
        device?.properties?.online === true ||
        String(device?.properties?.online || "").toLowerCase() === "true";
      return {
        online,
        provider: "seam",
        detail: device?.display_name || deviceId,
        battery: device?.properties?.battery_level ?? null,
      };
    } catch (err) {
      return {
        online: false,
        provider: "seam",
        detail: String(err?.message || err || "seam_status_failed"),
      };
    }
  },

  async getLogs() {
    return [];
  },
};

module.exports = {
  seamAdapter,
  parseSeamAccessCode,
  isSeamManagedCredentialId,
};
