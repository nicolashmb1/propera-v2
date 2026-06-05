/**
 * Realtime speech / accent instructions — injected into voice system prompts.
 * OpenAI has no accent API flag; short stable prompt blocks work best.
 */

const { voiceSpeakingStyle } = require("../config/env");

const STYLE_BLOCKS = {
  british: `## Speech
Speak English with a clear British accent.
- Keep this accent stable from the first word to the last.
- Use natural British vowel shaping and pacing — professional building staff, not exaggerated.
- Do not shift to American English mid-call.
- Do not change response language based on the caller's accent.`,

  american: `## Speech
Speak English with a natural American accent.
- Keep delivery stable for the whole call — calm, professional US building staff.
- Do not shift to other accents mid-call.
- Do not change response language based on the caller's accent.`,

  australian: `## Speech
Speak English with a light Australian accent.
- Keep the accent stable from the first word to the last.
- Use natural Australian vowel shaping, but keep speech easy to understand.
- Do not exaggerate the accent.
- Do not change response language based on the caller's accent.`,
};

/**
 * @param {string} [styleOverride] — british | american | australian | neutral
 * @returns {string} Prompt block or empty string for neutral.
 */
function buildSpeakingStylePromptBlock(styleOverride) {
  const key = String(styleOverride || voiceSpeakingStyle()).trim().toLowerCase();
  if (!key || key === "neutral" || key === "default" || key === "none") return "";
  return STYLE_BLOCKS[key] || "";
}

module.exports = { buildSpeakingStylePromptBlock, STYLE_BLOCKS };
