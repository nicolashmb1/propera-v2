const {
  openaiApiKey,
  openaiCommDraftModel,
  commMainNumberDisplay,
} = require("../config/env");
const { openaiChatCompletionsWithRetry } = require("../integrations/openaiTransport");

function normalizeLanguage(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return value || "en";
}

function normalizeTone(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return value || "professional";
}

function normalizeBody(raw) {
  let text = String(raw || "").replace(/\r\n/g, "\n").trim();
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function cleanupGeneratedBody(raw) {
  let text = normalizeBody(raw);
  if (!text) return "";

  const footerNeedle = String(commMainNumberDisplay() || "").trim();
  if (footerNeedle && text.includes(footerNeedle)) {
    text = text.replace(new RegExp("\\n?\\n?.*" + escapeRegex(footerNeedle) + ".*$", "is"), "");
    text = normalizeBody(text);
  }

  text = text
    .replace(/\bPropera\b/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const GSM_BASIC_CHARS = new Set(
  (
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ" +
    " !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
  ).split("")
);
const GSM_EXTENDED_CHARS = new Set(["^", "{", "}", "\\", "[", "~", "]", "|", "€", "\f"]);

function estimateSmsSegments(messageBody) {
  const text = String(messageBody || "");
  const chars = Array.from(text);
  if (!chars.length) {
    return {
      encoding: "GSM-7",
      characters: 0,
      sizeUnits: 0,
      segments: 0,
      perSegment: 160,
      remainingInSegment: 160,
    };
  }

  let isGsm = true;
  let sizeUnits = 0;
  for (const ch of chars) {
    if (GSM_BASIC_CHARS.has(ch)) {
      sizeUnits += 1;
      continue;
    }
    if (GSM_EXTENDED_CHARS.has(ch)) {
      sizeUnits += 2;
      continue;
    }
    isGsm = false;
    break;
  }

  if (!isGsm) {
    sizeUnits = chars.length;
    const single = 70;
    const multi = 67;
    const segments = sizeUnits <= single ? 1 : Math.ceil(sizeUnits / multi);
    const perSegment = segments > 1 ? multi : single;
    return {
      encoding: "UCS-2",
      characters: chars.length,
      sizeUnits,
      segments,
      perSegment,
      remainingInSegment: segments * perSegment - sizeUnits,
    };
  }

  const single = 160;
  const multi = 153;
  const segments = sizeUnits <= single ? 1 : Math.ceil(sizeUnits / multi);
  const perSegment = segments > 1 ? multi : single;
  return {
    encoding: "GSM-7",
    characters: chars.length,
    sizeUnits,
    segments,
    perSegment,
    remainingInSegment: segments * perSegment - sizeUnits,
  };
}

function fallbackDraftMessage(input) {
  const opts = input && typeof input === "object" ? input : {};
  const brief = normalizeBody(opts.brief);
  const audienceLabel = String(opts.audienceLabel || "").trim();
  const commType = String(opts.commType || "").trim().toUpperCase();
  const language = normalizeLanguage(opts.language);

  if (!brief) return "";

  if (language === "es") {
    if (commType === "EMERGENCY_ALERT") {
      return normalizeBody("Atencion: " + brief);
    }
    if (audienceLabel) {
      return normalizeBody("Hola " + audienceLabel + ",\n\n" + brief);
    }
    return brief;
  }

  if (language === "pt") {
    if (commType === "EMERGENCY_ALERT") {
      return normalizeBody("Atencao: " + brief);
    }
    if (audienceLabel) {
      return normalizeBody("Ola " + audienceLabel + ",\n\n" + brief);
    }
    return brief;
  }

  if (commType === "EMERGENCY_ALERT") {
    return normalizeBody("Attention: " + brief);
  }
  if (audienceLabel) {
    return normalizeBody("Hello " + audienceLabel + ",\n\n" + brief);
  }
  return brief;
}

function buildDraftPrompt(input) {
  const opts = input && typeof input === "object" ? input : {};
  const brandContext = opts.brandContext && typeof opts.brandContext === "object"
    ? opts.brandContext
    : { orgBrandName: "", orgBrandShort: "", properties: {} };
  const propertyNames = Object.values(brandContext.properties || {})
    .map((p) => String(p && p.displayName ? p.displayName : "").trim())
    .filter(Boolean)
    .slice(0, 8);

  const system =
    "You draft tenant-facing SMS notices for a property operations company.\n" +
    "Return plain text only. No markdown, no bullets unless the input clearly requires them.\n" +
    "Keep the message concise, practical, and ready for SMS.\n" +
    "Do not include any footer, opt-out language, phone number, or signature line. Another layer adds that later.\n" +
    "Do not mention the product name Propera.\n" +
    "Use the requested language and tone.\n";

  const user =
    JSON.stringify({
      brief: String(opts.brief || "").trim(),
      comm_type: String(opts.commType || "").trim(),
      tone: normalizeTone(opts.tone),
      language: normalizeLanguage(opts.language),
      audience_label: String(opts.audienceLabel || "").trim(),
      organization_brand: String(brandContext.orgBrandName || "").trim(),
      property_names: propertyNames,
    });

  return { system, user };
}

async function draftMessage(input) {
  const opts = input && typeof input === "object" ? input : {};
  const brief = normalizeBody(opts.brief);
  if (!brief) return { ok: false, error: "missing_brief", body: "", aiAssisted: false };

  const apiKey = openaiApiKey();
  if (!apiKey) {
    return {
      ok: true,
      body: fallbackDraftMessage(opts),
      aiAssisted: false,
    };
  }

  const prompt = buildDraftPrompt(opts);
  const r = await openaiChatCompletionsWithRetry({
    apiKey,
    timeoutMs: 22000,
    maxRetries: 2,
    body: {
      model: openaiCommDraftModel(),
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.4,
    },
  });

  if (!r.ok || !r.data) {
    return {
      ok: true,
      body: fallbackDraftMessage(opts),
      aiAssisted: false,
      warning: r.err || "draft_fallback",
    };
  }

  const content =
    r.data.choices &&
    r.data.choices[0] &&
    r.data.choices[0].message &&
    r.data.choices[0].message.content;
  const body = cleanupGeneratedBody(content);
  if (!body) {
    return {
      ok: true,
      body: fallbackDraftMessage(opts),
      aiAssisted: false,
      warning: "empty_llm_draft",
    };
  }

  return {
    ok: true,
    body,
    aiAssisted: true,
  };
}

function appendFooter(messageBody, brandContext, propertyCode, mainNumberDisplay, language, input) {
  const body = normalizeBody(messageBody);
  if (!body) return "";

  const ctx = brandContext && typeof brandContext === "object" ? brandContext : { properties: {} };
  const code = String(propertyCode || "").trim().toUpperCase();
  const propertyCtx = (ctx.properties && ctx.properties[code]) || null;
  const isMultiProperty = !!(input && input.isMultiProperty);
  const label =
    (propertyCtx && propertyCtx.senderLabel) ||
    (isMultiProperty
      ? String(ctx.orgBrandShort || ctx.orgBrandName || "Management").trim()
      : propertyCtx && propertyCtx.displayName
        ? "Management at " + propertyCtx.displayName
        : String(ctx.orgBrandShort || ctx.orgBrandName || "Management").trim());
  const mainLine = String(mainNumberDisplay || "").trim() || commMainNumberDisplay();
  const lang = normalizeLanguage(language);

  let redirectLine = "For maintenance, call or text " + mainLine + ".";
  let stopLine = "Reply STOP to opt out.";
  if (lang === "es") {
    redirectLine = "Para mantenimiento, llame o envie un texto al " + mainLine + ".";
    stopLine = "Responda STOP para dejar de recibir mensajes.";
  } else if (lang === "pt") {
    redirectLine = "Para manutencao, ligue ou envie mensagem para " + mainLine + ".";
    stopLine = "Responda STOP para sair.";
  }

  return normalizeBody(body + "\n\n- " + label + "\n" + redirectLine + "\n" + stopLine);
}

module.exports = {
  draftMessage,
  appendFooter,
  fallbackDraftMessage,
  estimateSmsSegments,
};
