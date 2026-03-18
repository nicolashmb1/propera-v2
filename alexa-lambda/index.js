/**
 * Propera Alexa Lambda Relay — THIN / TRANSPORT ONLY
 * Runtime: Node.js 20.x+
 *
 * Purpose:
 * - Accept Alexa request envelope
 * - Normalize into pre-normalized GAS payload
 * - POST to Propera GAS webhook
 * - Return Alexa JSON response
 *
 * No business logic here.
 * No maintenance logic.
 * No scheduling logic.
 * No SMS logic.
 */

const MSG_LAUNCH = "How can I help you today?";
const MSG_RECEIPT = "Hi. We received your request. Our team will follow up with any other instructions by text.";
const MSG_FALLBACK = "Sorry, I did not catch that. Please tell me your request again.";

function buildAlexaResponse(text, shouldEndSession = true, repromptText = "") {
  const resp = {
    version: "1.0",
    response: {
      outputSpeech: {
        type: "PlainText",
        text: String(text || "").trim() || "Propera processed the request."
      },
      shouldEndSession: !!shouldEndSession
    }
  };

  if (!shouldEndSession && repromptText && String(repromptText).trim()) {
    resp.response.reprompt = {
      outputSpeech: {
        type: "PlainText",
        text: String(repromptText).trim()
      }
    };
  }

  return resp;
}

function isValidAlexaResponse(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.version !== "1.0") return false;

  const response = obj.response;
  if (!response || typeof response !== "object") return false;

  const os = response.outputSpeech;
  if (!os || typeof os !== "object") return false;
  if (os.type !== "PlainText") return false;
  if (typeof os.text !== "string" || !os.text.trim()) return false;

  if ("shouldEndSession" in response && typeof response.shouldEndSession !== "boolean") {
    return false;
  }

  if ("reprompt" in response) {
    const reprompt = response.reprompt;
    if (!reprompt || typeof reprompt !== "object") return false;
    const ros = reprompt.outputSpeech;
    if (!ros || typeof ros !== "object") return false;
    if (ros.type !== "PlainText") return false;
    if (typeof ros.text !== "string" || !ros.text.trim()) return false;
  }

  return true;
}

function get(obj, path, fallback = "") {
  if (obj == null) return fallback;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return fallback;
    cur = cur[p];
  }
  return cur !== undefined && cur !== null ? cur : fallback;
}

function extractRawTextFromIntent(intent) {
  if (!intent || typeof intent !== "object") return "";
  const slots = intent.slots;
  if (!slots || typeof slots !== "object") return "";

  const preferred = ["query", "RequestText", "issue", "TimeText"];
  for (const key of preferred) {
    if (slots[key] && slots[key].value) {
      return String(slots[key].value).trim();
    }
  }

  const values = Object.keys(slots)
    .map((k) => (slots[k] && slots[k].value ? String(slots[k].value).trim() : ""))
    .filter(Boolean);

  return values.length ? values.join(" ").trim() : "";
}

function normalizeAlexaEnvelope(requestEnvelope) {
  const request = get(requestEnvelope, "request", {});
  const session = get(requestEnvelope, "session", {});
  const context = get(requestEnvelope, "context", {});
  const system = get(context, "System", {});
  const device = get(system, "device", {});

  const reqType = get(request, "type", "");
  let rawText = "";
  let intentName = "CaptureIntent";

  if (reqType === "LaunchRequest") {
    intentName = "LaunchRequest";
    rawText = "";
  } else if (reqType === "IntentRequest") {
    const intent = get(request, "intent", {});
    intentName = get(intent, "name", "CaptureIntent");
    rawText = extractRawTextFromIntent(intent);
  } else if (reqType === "SessionEndedRequest") {
    intentName = "SessionEndedRequest";
    rawText = "";
  }

  return {
    alexaRequest: true,
    secret: process.env.ALEXA_WEBHOOK_SECRET || "",
    rawText: rawText,
    intentName: intentName,
    sessionId: get(session, "sessionId", ""),
    alexaUserId: get(system, "user.userId", "") || get(session, "user.userId", ""),
    deviceId: get(device, "deviceId", ""),
    locale: get(request, "locale", "en-US"),
    requestId: get(request, "requestId", ""),
    timestamp: get(request, "timestamp", "")
  };
}

async function postToGas(url, payload, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const text = await res.text();
    if (!res.ok) {
      console.error("GAS status", res.status, "body length", text.length);
      return null;
    }

    if (!text || !text.trim()) return null;

    try {
      return JSON.parse(text);
    } catch (e) {
      console.error("GAS parse failure", e.message);
      return null;
    }
  } catch (e) {
    clearTimeout(timeout);
    console.error("relay error", e.message);
    return null;
  }
}

export async function handler(event) {
  const requestEnvelope = event && typeof event === "object" ? event : {};

  try {
    const webhookUrl = String(process.env.PROPERA_GAS_WEBHOOK_URL || "").trim();
    const secret = String(process.env.ALEXA_WEBHOOK_SECRET || "").trim();

    if (!webhookUrl || !secret) {
      console.error("missing env: PROPERA_GAS_WEBHOOK_URL or ALEXA_WEBHOOK_SECRET");
      return buildAlexaResponse("Propera is not configured correctly.", true);
    }

    const reqType = get(requestEnvelope, "request.type", "");
    console.log("request type", reqType);

    if (reqType === "SessionEndedRequest") {
      return buildAlexaResponse("Goodbye.", true);
    }

    const payload = normalizeAlexaEnvelope(requestEnvelope);

    console.log("intentName", payload.intentName);
    console.log("rawText", payload.rawText ? payload.rawText.slice(0, 120) : "(empty)");
    console.log("sessionIdLen", payload.sessionId ? payload.sessionId.length : 0);

    // Launch: let GAS answer if available, otherwise local launch fallback
    if (payload.intentName === "LaunchRequest") {
      const gasResponse = await postToGas(webhookUrl, payload, 5000);
      if (gasResponse && isValidAlexaResponse(gasResponse)) return gasResponse;
      return buildAlexaResponse(MSG_LAUNCH, false, MSG_LAUNCH);
    }

    // Empty capture / fallback
    if (!payload.rawText) {
      return buildAlexaResponse(MSG_FALLBACK, false, MSG_FALLBACK);
    }

    // Package delivery only: GAS should enqueue + acknowledge quickly
    const gasResponse = await postToGas(webhookUrl, payload, 5000);
    if (gasResponse && isValidAlexaResponse(gasResponse)) {
      return gasResponse;
    }

    // Safe transport fallback: delivery receipt only
    return buildAlexaResponse(MSG_RECEIPT, true);

  } catch (err) {
    console.error("Lambda unexpected error", err.message);
    return buildAlexaResponse(MSG_RECEIPT, true);
  }
}
