const { generatePin } = require("../credentialCrypto");

/**
 * Pilot adapter — PIN generated in Propera; staff sets physical lock manually.
 */
const noopAdapter = {
  /**
   * @param {object} _lockRow
   * @param {Date} validFrom
   * @param {Date} validUntil
   */
  async issueCredential(_lockRow, validFrom, validUntil) {
    const pin = generatePin();
    return {
      credentialType: "pin",
      credentialValue: pin,
      validFrom,
      validUntil,
      externalCredentialId: `noop-${Date.now()}`,
    };
  },

  async revokeCredential() {
    return { ok: true };
  },

  async getStatus() {
    return { online: true, provider: "noop", detail: "manual_lock" };
  },

  async getLogs() {
    return [];
  },
};

module.exports = { noopAdapter };
