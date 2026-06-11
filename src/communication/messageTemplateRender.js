/**
 * Render org SMS templates with property-aware placeholders.
 */

function buildTemplateVars(brandContext, propertyCode, senderLabel) {
  const ctx = brandContext && typeof brandContext === "object" ? brandContext : {};
  const code = String(propertyCode || "").trim().toUpperCase();
  const propertyCtx = code && ctx.properties ? ctx.properties[code] : null;
  const building = propertyCtx ? String(propertyCtx.displayName || "").trim() : "";

  return {
    brand: String(ctx.orgBrandName || "").trim(),
    brand_short: String(ctx.orgBrandShort || "").trim(),
    building,
    property: building,
    property_code: code,
    sender_label: String(senderLabel || "").trim(),
  };
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyPlaceholder(text, key, value) {
  let out = String(text || "");
  const val = String(value ?? "");
  out = out.replace(new RegExp("\\{" + escapeRegex(key) + "\\}", "gi"), val);
  out = out.replace(new RegExp("<" + escapeRegex(key) + ">", "gi"), val);
  return out;
}

function renderSmsTemplate(template, vars) {
  const raw = String(template || "").trim();
  if (!raw) return "";

  const keys = ["brand_short", "brand", "sender_label", "property_code", "building", "property"];
  let out = raw;
  for (const key of keys) {
    out = applyPlaceholder(out, key, vars[key]);
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function stopLineForLanguage(language) {
  const lang = String(language || "en").trim().toLowerCase() || "en";
  if (lang === "es") return "Responda STOP para dejar de recibir mensajes.";
  if (lang === "pt") return "Responda STOP para sair.";
  return "Reply STOP to opt out.";
}

function messageIncludesStopLine(text) {
  return /\bSTOP\b/i.test(String(text || ""));
}

module.exports = {
  buildTemplateVars,
  renderSmsTemplate,
  stopLineForLanguage,
  messageIncludesStopLine,
};
