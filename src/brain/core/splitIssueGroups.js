const { localCategoryFromText } = require("../../dal/ticketDefaults");

function hasProblemSignal(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (localCategoryFromText(t)) return true;
  return /\b(leak|leaking|broken|not working|does not|doesn't|wont|won't|no\b|clog|drain|filter|hot|cold|run)\b/i.test(
    t
  );
}

function splitDistinctIssueClauses(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  let parts = raw
    .split(/\s*[.!?]+\s*|\s+(?:also|and\s+also|i\s+also|plus|btw|by\s+the\s+way)\s+/i)
    .map((x) => String(x || "").trim())
    .filter((x) => x.length >= 4);

  const out = [];
  for (const p of parts) {
    const andParts = p
      .split(/\s+\band\b\s+/i)
      .map((x) => String(x || "").trim())
      .filter((x) => x.length >= 4);
    if (andParts.length >= 2 && andParts.every((x) => hasProblemSignal(x))) {
      out.push(...andParts);
    } else {
      out.push(p);
    }
  }
  return out;
}

function inferSystemKey(text, category) {
  const t = String(text || "").toLowerCase();
  if (/\b(ac|a\/c|hvac|heat|heater|furnace|thermostat|air)\b/.test(t)) return "HVAC";
  if (/\b(ice maker|icemaker|fridge|refrigerator|stove|oven|dishwasher|washer|dryer|appliance)\b/.test(t))
    return "APPLIANCE";
  if (/\b(toilet|sink|faucet|drain|pipe|plumbing|water)\b/.test(t)) return "PLUMBING";
  if (/\b(light|breaker|outlet|electrical|electric)\b/.test(t)) return "ELECTRICAL";
  return String(category || "GENERAL").toUpperCase() || "GENERAL";
}

function buildIssueTicketGroups(issueText) {
  const clauses = splitDistinctIssueClauses(issueText);
  if (!clauses.length) return [{ issueText: String(issueText || "").trim(), key: "single" }];
  const groups = {};
  const order = [];
  for (const c of clauses) {
    const cat = localCategoryFromText(c) || "General";
    const sys = inferSystemKey(c, cat);
    const key = String(sys).toUpperCase();
    if (!groups[key]) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(c);
  }
  return order.map((k) => ({
    key: k,
    issueText: groups[k].join(" | ").slice(0, 900),
  }));
}

module.exports = {
  splitDistinctIssueClauses,
  buildIssueTicketGroups,
};
