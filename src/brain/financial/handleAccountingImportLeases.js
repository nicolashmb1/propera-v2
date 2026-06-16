/**
 * @deprecated Use handleAccountingImportSignals — legacy route delegates there.
 */
const { handleAccountingImportSignals } = require("./handleAccountingImportSignals");

/** @param {import("express").Request} req @param {import("express").Response} res */
async function handleMaterializeLeasesFromImport(req, res) {
  return handleAccountingImportSignals(req, res);
}

module.exports = { handleMaterializeLeasesFromImport };
