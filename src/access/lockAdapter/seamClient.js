const { Seam } = require("seam");
const { seamApiKey } = require("../../config/env");

let _client = null;
/** @type {import("seam").Seam | null} */
let _testClient = null;

/** @param {import("seam").Seam | null} client */
function setSeamClientForTests(client) {
  _testClient = client;
}

function getSeamClient() {
  if (_testClient) return _testClient;
  const key = seamApiKey();
  if (!key) throw new Error("seam_api_key_missing");
  if (!_client) _client = new Seam({ apiKey: key });
  return _client;
}

module.exports = { getSeamClient, setSeamClientForTests };
