/**
 * GAS-shaped structured signal — `properaStructuredSignalEmpty_` / validation
 * (`07_PROPERA_INTAKE_PACKAGE.gs` ~1122–1167).
 */

function properaStructuredSignalEmpty() {
  return {
    actorType: "UNKNOWN",
    operationMode: "WRITE",
    intentType: "",
    propertyCode: "",
    propertyName: "",
    unit: "",
    turnType: "UNKNOWN",
    conversationMove: "NONE",
    statusQueryType: "NONE",
    conversationalReply: "",
    issues: [],
    schedule: null,
    actionSignals: {},
    queryType: "",
    targetHints: {},
    confidence: 0,
    ambiguity: { flags: [], notes: "" },
    domainHint: "UNKNOWN",
    safety: {
      isEmergency: false,
      emergencyType: "",
      skipScheduling: false,
      requiresImmediateInstructions: false,
    },
    extractionSource: "",
  };
}

function properaRawStructuredSignalIsValid(obj) {
  if (!obj || typeof obj !== "object") return false;
  const tt = String(obj.turnType || "")
    .toUpperCase()
    .trim();
  if (
    tt === "CONVERSATIONAL_ONLY" ||
    tt === "STATUS_QUERY" ||
    tt === "MIXED" ||
    tt === "UNKNOWN"
  ) {
    return true;
  }
  const sched = obj.schedule;
  if (sched && typeof sched === "object" && String(sched.raw || "").trim()) return true;
  const arr = obj.issues;
  if (!Array.isArray(arr) || arr.length < 1) return false;
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it || typeof it !== "object") return false;
    const sum = String(it.summary || it.title || "").trim();
    if (!sum) return false;
  }
  return true;
}

module.exports = {
  properaStructuredSignalEmpty,
  properaRawStructuredSignalIsValid,
};
