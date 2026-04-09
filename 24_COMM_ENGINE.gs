/**
 * COMMUNICATIONS ENGINE — Broadcast / floor / unit targeting.
 * Depends on globals from main script: LOG_SHEET_ID, DEV_MODE.
 * Entry: doGet calls buildRecipients(commId) / queueCommunication(commId);
 *        time trigger calls processQueuedCommunications().
 * Sheets: Communications, CommTargets, CommRecipients, Tenants (in LOG_SHEET_ID spreadsheet).
 */

/*******************************************************
 * COMMUNICATIONS ENGINE (Broadcast / Floor / Unit pick)
 * Sheets: Communications, CommTargets, CommRecipients, Tenants
 *
 * Targets:
 * - SendAllProperties = TRUE => all Active tenants
 * - Property => all Active tenants in that property
 * - Floor (requires Property) => units on that floor in that property
 * - Unit  (requires Property + Unit) => only those units in that property
 *
 * Flow:
 * 1) buildRecipients(commId)        -> fills CommRecipients, sets Communications.Status="Built"
 * 2) queueCommunication(commId)     -> sets Status="Queued"
 * 3) processQueuedCommunications()  -> (time trigger) sends to Pending recipients
 *******************************************************/

// >>> SET THESE <<<
const TENANTS_TAB = "Tenants";
const COMM_TAB = "Communications";
const TARGETS_TAB = "CommTargets";
const RECIP_TAB = "CommRecipients";

// -----------------------------------------------------
// PUBLIC FUNCTIONS (no trailing underscore)
// -----------------------------------------------------

function buildRecipients(commId) {
  if (!commId) throw new Error("Missing commId");
  commId = String(commId).trim();

  const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
  const tenantsSh = commMustGetSheet_(ss, TENANTS_TAB);
  const commSh = commMustGetSheet_(ss, COMM_TAB);
  const targetsSh = commMustGetSheet_(ss, TARGETS_TAB);
  const recipSh = commMustGetSheet_(ss, RECIP_TAB);

  // Communications row
  const commRow = commGetRowByKey_(commSh, "CommID", commId);
  if (!commRow) throw new Error("CommID not found: " + commId);

  commRequireHeaders_(commRow.table, ["CommID", "Status", "Message", "SendAllProperties", "Summary", "SendAt", "SentAt"], "Communications");

  const sendAll = commToBool_(commRow.obj.SendAllProperties);

  // Targets for this comm
  const targets = commGetTargetsForComm_(targetsSh, commId);

  // Parse targets into sets
  const propertySet = new Set();
  const floorSetByProp = {}; // {PENN: Set(4,5)}
  const unitSetByProp = {};  // {PENN: Set(401,402)}

  targets.forEach(t => {
    const type = String(t.TargetType || "").trim().toLowerCase();
    const prop = commPropToCode_(t.Property);
    const floor = commParseOptionalInt_(t.Floor);
    const unit = commParseOptionalInt_(t.Unit);

    if (type === "property" && prop) {
      propertySet.add(prop);
      return;
    }

    if (type === "floor") {
      if (!prop) return;          // floor requires property
      if (floor == null) return;  // floor requires a number
      if (!floorSetByProp[prop]) floorSetByProp[prop] = new Set();
      floorSetByProp[prop].add(floor);
      propertySet.add(prop);
      return;
    }

    if (type === "unit") {
      if (!prop) return;         // unit requires property
      if (unit == null) return;  // unit requires a number
      if (!unitSetByProp[prop]) unitSetByProp[prop] = new Set();
      unitSetByProp[prop].add(unit);
      propertySet.add(prop);
      return;
    }
  });

  // Read tenants
  const tenTable = commReadTable_(tenantsSh);
  commRequireHeaders_(tenTable, ["Property", "Unit", "Phone", "Name", "Active"], "Tenants");

  const activeTenants = tenTable.rows.filter(r => commToBool_(r.Active));

  // Build recipients (dedupe by phone)
  const recipients = [];
  const seenPhone = new Set();

  activeTenants.forEach(t => {
    const phone = commNormalizePhone_(t.Phone);
    if (!phone) return;

    const prop = commPropToCode_(t.Property);
    const unitNum = commParseOptionalInt_(t.Unit);

    // SendAll => everyone active
    if (sendAll) {
      if (seenPhone.has(phone)) return;
      recipients.push(commMakeRecipientObj_(commId, phone, t));
      seenPhone.add(phone);
      return;
    }

    // If no targets and not sendAll => do nothing
    if (propertySet.size === 0) return;

    // Must match property
    if (!prop || !propertySet.has(prop)) return;

    // If explicit unit picks exist for property => ONLY those units
    const unitSet = unitSetByProp[prop];
    if (unitSet && unitSet.size > 0) {
      if (unitNum == null || !unitSet.has(unitNum)) return;
    } else {
      // else floors apply (if present)
      const floorSet = floorSetByProp[prop];
      if (floorSet && floorSet.size > 0) {
        if (unitNum == null) return;
        const floor = Math.floor(unitNum / 100); // 101->1, 404->4
        if (!floorSet.has(floor)) return;
      }
      // else property-only => all in property
    }

    if (seenPhone.has(phone)) return;
    recipients.push(commMakeRecipientObj_(commId, phone, t));
    seenPhone.add(phone);
  });

  // Clear existing recipients for CommID then append new ones
  commDeleteRecipientsForComm_(recipSh, commId);

  if (recipients.length > 0) {
    commAppendObjects_(recipSh, recipients);
  }

  commUpdateCommStatus_(commSh, commId, "Built", "Recipients built: " + recipients.length);

  return { ok: true, commId: commId, recipients: recipients.length };
}

function queueCommunication(commId) {
  if (!commId) throw new Error("Missing commId");
  commId = String(commId).trim();

  const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
  const commSh = commMustGetSheet_(ss, COMM_TAB);

  const commRow = commGetRowByKey_(commSh, "CommID", commId);
  if (!commRow) throw new Error("CommID not found: " + commId);

  commUpdateCommStatus_(commSh, commId, "Queued", "Queued for sending");
  return { ok: true, commId: commId };
}

function processQueuedCommunications() {
  const props = PropertiesService.getScriptProperties();
  const TWILIO_SID = props.getProperty("TWILIO_SID");
  const TWILIO_TOKEN = props.getProperty("TWILIO_TOKEN");
  const TWILIO_NUMBER = props.getProperty("TWILIO_NUMBER");

  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_NUMBER) {
    throw new Error("Missing Twilio creds: TWILIO_SID / TWILIO_TOKEN / TWILIO_NUMBER");
  }

  const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
  const commSh = commMustGetSheet_(ss, COMM_TAB);
  const recipSh = commMustGetSheet_(ss, RECIP_TAB);

  const commTable = commReadTable_(commSh);
  commRequireHeaders_(commTable, ["CommID", "Status", "Message", "Summary", "SendAt", "SentAt"], "Communications");

  const queued = commTable.rows.filter(r => String(r.Status || "").trim() === "Queued");
  if (queued.length === 0) return;

  // Read recipients ONCE and group by CommID
  const recipTable = commReadTable_(recipSh);
  commRequireHeaders_(recipTable, ["RecipientID", "CommID", "Phone", "Status", "Error", "SentAt"], "CommRecipients");

  const byComm = {};
  recipTable.rows.forEach(r => {
    const cid = String(r.CommID || "").trim();
    if (!cid) return;
    if (!byComm[cid]) byComm[cid] = [];
    byComm[cid].push(r);
  });

  const MAX_PER_COMM_RUN = 200; // prevents quotas; next trigger run continues

  queued.forEach(comm => {
    const commId = String(comm.CommID || "").trim();
    const message = String(comm.Message || "").trim();

    if (!commId || !message) {
      commUpdateCommStatus_(commSh, commId, "Failed", "Missing CommID or Message");
      return;
    }

    commUpdateCommStatus_(commSh, commId, "Sending", "Sending started");

    const pending = (byComm[commId] || []).filter(r => String(r.Status || "").trim() === "Pending");
    if (pending.length === 0) {
      commUpdateCommFinal_(commSh, commId, "Sent", "No Pending recipients (already sent?)");
      return;
    }

    const slice = pending.slice(0, MAX_PER_COMM_RUN);

    let sent = 0, failed = 0;
    const updates = []; // { rowIndex, obj }

    slice.forEach(r => {
      const rid = String(r.RecipientID || "").trim();
      const phone = commNormalizePhone_(r.Phone);
      if (!rid) return;

      try {
        if (!phone) throw new Error("Invalid phone");
        commSendSmsViaTwilio_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, phone, message);

        updates.push({ rowIndex: r.__row, obj: { Status: "Sent", SentAt: new Date(), Error: "" } });
        sent++;
      } catch (err) {
        updates.push({
          rowIndex: r.__row,
          obj: { Status: "Failed", SentAt: new Date(), Error: String(err && err.message ? err.message : err) }
        });
        failed++;
      }
    });

    commBulkUpdateRows_(recipSh, updates);

    const remaining = pending.length - slice.length;
    const summary = `Sent=${sent}, Failed=${failed}` + (remaining > 0 ? ` (remaining=${remaining})` : "");

    if (remaining > 0) {
      // keep queued so the next trigger run continues
      commUpdateCommStatus_(commSh, commId, "Queued", summary);
      return;
    }

    const finalStatus = failed > 0 ? (sent > 0 ? "Sent" : "Failed") : "Sent";
    commUpdateCommFinal_(commSh, commId, finalStatus, summary);
  });
}

// -----------------------------------------------------
// HELPERS (COMM ONLY) — prefixed comm* to avoid clashes
// -----------------------------------------------------

function commMustGetSheet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error("Missing sheet tab: " + name);
  return sh;
}

function commReadTable_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (!values || values.length < 1) return { sheet: sheet, headers: [], hmap: {}, rows: [] };

  const headers = values[0].map(h => String(h || "").trim());
  const hmap = {};
  headers.forEach((h, i) => { if (h) hmap[h.toLowerCase()] = i; });

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const arr = values[i];
    const obj = {};
    headers.forEach((h, j) => { if (h) obj[h] = arr[j]; });
    obj.__row = i + 1; // actual sheet row number
    rows.push(obj);
  }
  return { sheet: sheet, headers: headers, hmap: hmap, rows: rows };
}

function commRequireHeaders_(table, required, label) {
  const missing = required.filter(h => table.hmap[h.toLowerCase()] == null);
  if (missing.length) throw new Error(label + " missing required headers: " + missing.join(", "));
}

function commGetRowByKey_(sheet, keyHeader, keyValue) {
  const t = commReadTable_(sheet);
  commRequireHeaders_(t, [keyHeader], sheet.getName());
  const hit = t.rows.find(r => String(r[keyHeader] || "").trim() === String(keyValue).trim());
  if (!hit) return null;
  return { table: t, obj: hit, rowIndex: hit.__row };
}

function commGetTargetsForComm_(targetsSheet, commId) {
  const t = commReadTable_(targetsSheet);
  commRequireHeaders_(t, ["CommID", "TargetType", "Property", "Floor", "Unit"], "CommTargets");
  const id = String(commId).trim();
  return t.rows
    .filter(r => String(r.CommID || "").trim() === id)
    .map(r => ({
      TargetType: r.TargetType,
      Property: r.Property,
      Floor: r.Floor,
      Unit: r.Unit
    }));
}

function commDeleteRecipientsForComm_(recipSheet, commId) {
  const t = commReadTable_(recipSheet);
  commRequireHeaders_(t, ["CommID"], "CommRecipients");

  const keep = [t.headers];
  const id = String(commId).trim();

  t.rows.forEach(r => {
    if (String(r.CommID || "").trim() !== id) {
      keep.push(t.headers.map(h => r[h]));
    }
  });

  recipSheet.clearContents();
  recipSheet.getRange(1, 1, 1, t.headers.length).setValues([t.headers]);

  if (keep.length > 1) {
    recipSheet.getRange(2, 1, keep.length - 1, t.headers.length).setValues(keep.slice(1));
  }
}

function commAppendObjects_(sheet, objs) {
  if (!objs || objs.length === 0) return;

  const t = commReadTable_(sheet);
  const headers = t.headers;
  if (!headers || headers.length === 0) throw new Error(sheet.getName() + " needs headers in row 1");

  const out = objs.map(o => headers.map(h => (Object.prototype.hasOwnProperty.call(o, h) ? o[h] : "")));
  sheet.getRange(sheet.getLastRow() + 1, 1, out.length, headers.length).setValues(out);
}

function commBulkUpdateRows_(sheet, updates) {
  if (!updates || updates.length === 0) return;

  const data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return;

  const headers = data[0].map(h => String(h || "").trim().toLowerCase());
  const idx = {};
  headers.forEach((h, i) => { if (h) idx[h] = i; });

  updates.forEach(u => {
    const rowIndex = Number(u.rowIndex);
    const obj = u.obj || {};
    const r0 = rowIndex - 1;
    if (!data[r0]) return;

    Object.keys(obj).forEach(k => {
      const col = idx[String(k).trim().toLowerCase()];
      if (col == null) return;
      data[r0][col] = obj[k];
    });
  });

  sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
}

function commUpdateCommStatus_(commSheet, commId, status, summary) {
  if (!commId) return;

  const data = commSheet.getDataRange().getValues();
  if (!data || data.length < 2) return;

  const headers = data[0].map(h => String(h || "").trim().toLowerCase());

  const idxCommId = headers.indexOf("commid");
  const idxStatus = headers.indexOf("status");
  const idxSummary = headers.indexOf("summary");
  const idxSendAt = headers.indexOf("sendat");
  const idxSentAt = headers.indexOf("sentat");

  if (idxCommId < 0 || idxStatus < 0) {
    throw new Error("Communications must include CommID and Status headers.");
  }

  const id = String(commId).trim();

  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idxCommId] || "").trim() === id) {
      data[r][idxStatus] = status;

      if (idxSummary >= 0) data[r][idxSummary] = String(summary || "");

      // Stamp SendAt when queued (optional)
      if (idxSendAt >= 0 && status === "Queued" && !data[r][idxSendAt]) {
        data[r][idxSendAt] = new Date();
      }

      // Stamp SentAt when final (optional)
      if (idxSentAt >= 0 && (status === "Sent" || status === "Failed") && !data[r][idxSentAt]) {
        data[r][idxSentAt] = new Date();
      }

      commSheet.getRange(1, 1, data.length, data[0].length).setValues(data);
      return;
    }
  }

  throw new Error("CommID not found: " + commId);
}

function commUpdateCommFinal_(commSheet, commId, status, summary) {
  commUpdateCommStatus_(commSheet, commId, status, summary);
}

function commMakeRecipientObj_(commId, phone, tenantRowObj) {
  const rid = "RID_" + commId + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);

  const prop = commPropToCode_(tenantRowObj.Property);
  const unit = tenantRowObj.Unit;
  const name = tenantRowObj.Name || "";

  // Matches CommRecipients headers exactly:
  return {
    RecipientID: rid,
    CommID: commId,
    Property: prop,
    Unit: unit,
    Phone: phone,
    Name: name,
    Status: "Pending",
    Error: "",
    SentAt: ""
  };
}

function commToBool_(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return s === "" || s === "true" || s === "yes" || s === "y" || s === "1" || s === "on";
}

function commParseOptionalInt_(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.trunc(n);
}

function commPropToCode_(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "";

  // If already a short code, keep
  if (["PENN", "MORRIS", "MURRAY", "WESTFIELD", "WESTGRAND"].includes(s)) return s;

  // Heuristic mapping from names
  if (s.includes("PENN")) return "PENN";
  if (s.includes("MORRIS")) return "MORRIS";
  if (s.includes("MURRAY")) return "MURRAY";
  if (s.includes("WESTFIELD")) return "WESTFIELD";
  if (s.includes("WESTGRAND") || s.includes("WEST GRAND")) return "WESTGRAND";

  return s.replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function commNormalizePhone_(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (raw.startsWith("+") && digits.length >= 10) return "+" + digits;

  return "";
}

function commSendSmsViaTwilio_(sid, token, fromNumber, toNumber, message) {
  if (!sid || !token || !fromNumber) throw new Error("Missing Twilio credentials.");
  if (!toNumber) throw new Error("Missing destination phone.");
  if (!message) throw new Error("Missing message.");

  // DEV_MODE support
  if (typeof DEV_MODE !== "undefined" && DEV_MODE) {
    Logger.log("DEV COMM SMS -> " + toNumber + ": " + message);
    return;
  }

  const url = "https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json";
  const payload = { From: fromNumber, To: toNumber, Body: message };

  const options = {
    method: "post",
    payload: payload,
    headers: { Authorization: "Basic " + Utilities.base64Encode(sid + ":" + token) },
    muteHttpExceptions: true
  };

  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Twilio SMS failed: HTTP " + code + " — " + resp.getContentText());
  }
}
