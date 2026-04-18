/**
 * GAS `handleInboundRouter_` ATTACH_CLARIFY resolution — `16_ROUTER_ENGINE.gs` ~470–482.
 * @returns {{ outcome: 'attach' | 'start_new' | '', stripped: string }}
 */
function parseAttachClarifyReply(bodyTrim) {
  const raw = String(bodyTrim || "").trim();
  if (!raw) return { outcome: "", stripped: "" };

  if (/^\s*1\s*$/.test(raw)) return { outcome: "attach", stripped: "" };
  if (/^\s*2\s*$/.test(raw)) return { outcome: "start_new", stripped: "" };

  const lc = raw.toLowerCase();
  const mSame = lc.match(
    /^\s*(same request|same one|this one|this request)\b[\s,.\-:]*/i
  );
  if (mSame) {
    const cut = mSame[0] ? mSame[0].length : 0;
    return { outcome: "attach", stripped: raw.slice(cut).trim() };
  }
  const mNew = lc.match(
    /^\s*(new one|another|different apartment|different unit|other apartment|other unit)\b[\s,.\-:]*/i
  );
  if (mNew) {
    const cut = mNew[0] ? mNew[0].length : 0;
    return { outcome: "start_new", stripped: raw.slice(cut).trim() };
  }

  return { outcome: "", stripped: raw };
}

module.exports = { parseAttachClarifyReply };
