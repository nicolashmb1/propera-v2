/**
 * WATER ENGINE — Water meter reminders (self-contained).
 * Depends on globals from main script: LOG_SHEET_ID, DEV_MODE.
 * Sheet: WaterMeters (same spreadsheet as LOG_SHEET_ID).
 * Trigger: installWaterTriggers() → daily waterDailyCheck() at 9am.
 */

/*******************************************************
 * WATER METER REMINDERS (SIMPLE / ONE TAB) — HARDENED
 *
 * Sheet:
 *  - WaterMeters columns:
 *    A PropertyCode (required)
 *    B PropertyName (required)
 *    C NextReadingDate (required Date)
 *    D Active (TRUE/checkbox or blank = active)
 *    E LastMeterRead (optional text shown on reminders)
 *
 * Reminders (date-only, NY time):
 *  - 30 days before NextReadingDate
 *  - 15 days before
 *  - 7 days before
 *  - 5 days AFTER (EXACTLY 5 days after, once per scheduled date)
 *
 * Trigger:
 *  - installWaterTriggers() creates daily trigger for waterDailyCheck()
 *******************************************************/

const WATER_SHEET_ID = LOG_SHEET_ID;      // Spreadsheet ID where WaterMeters lives
const WATER_METERS_SHEET = "WaterMeters";
const WATER_TZ = "America/New_York";

const DEVLOG_SHEET_NAME = "DevSmsLog";    // your log tab
const WATER_SMS_TO = "+19083380390";      // your phone (+1...)

/************** TRIGGERS **************/
function installWaterTriggers() {
  // delete old triggers for waterDailyCheck
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "waterDailyCheck") ScriptApp.deleteTrigger(t);
  });

  // create new daily trigger (around 9am)
  ScriptApp.newTrigger("waterDailyCheck")
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();

  waterDevLog_("Installed daily trigger for waterDailyCheck at ~9am");
}

/************** MAIN DAILY CHECK **************/
function waterDailyCheck() {
  const ss = SpreadsheetApp.openById(WATER_SHEET_ID);
  const meters = ss.getSheetByName(WATER_METERS_SHEET);
  if (!meters) throw new Error(`Missing sheet tab: ${WATER_METERS_SHEET}`);

  const rows = meters.getDataRange().getValues();
  const today = todayStr_();

  waterDevLog_(`START waterDailyCheck — today=${today} rows=${rows.length}`);

  for (let r = 1; r < rows.length; r++) {
    const propertyCode = String(rows[r][0] || "").trim().toUpperCase();
    const propertyName = String(rows[r][1] || "").trim();
    const nextDate = rows[r][2];
    const activeRaw = rows[r][3];
    const lastMeterRead = String(rows[r][4] || "").trim(); // Column E

    // Active: blank or TRUE/checkbox/yes/1 = active
    const active = isActive_(activeRaw);
    if (!active) continue;

    if (!propertyCode || !propertyName) continue;

    if (!(nextDate instanceof Date) || isNaN(nextDate.getTime())) {
      waterDevLog_(`Row ${r + 1} skip: NextReadingDate not a Date (${nextDate})`);
      continue;
    }

    const scheduledStr = dateStr_(nextDate);
    const scheduledPretty = prettyDate_(nextDate);

    waterDevLog_(`Row ${r + 1} OK: ${propertyCode} ${propertyName} scheduled=${scheduledStr}`);

    const lastLine = lastMeterRead ? `LastMeterRead: ${lastMeterRead}` : "";

    // 30 days before
    sendIfDueDaysBefore_(propertyCode, scheduledStr, "D30", 30, () => {
      waterDevLog_(`${propertyCode} sending D30`);
      sendWaterSms_([
        `Water Reading for ${propertyName} in 30 days.`,
        `Estimated bill date: ${scheduledPretty}`,
        lastLine
      ].filter(Boolean).join("\n"));
    });

    // 15 days before
    sendIfDueDaysBefore_(propertyCode, scheduledStr, "D15", 15, () => {
      waterDevLog_(`${propertyCode} sending D15`);
      sendWaterSms_([
        `Water Reading for ${propertyName} in 15 days.`,
        `Estimated bill date: ${scheduledPretty}`,
        lastLine
      ].filter(Boolean).join("\n"));
    });

    // 7 days before
    sendIfDueDaysBefore_(propertyCode, scheduledStr, "D7", 7, () => {
      waterDevLog_(`${propertyCode} sending D7`);
      sendWaterSms_([
        `Water Reading for ${propertyName} in 7 days.`,
        `Estimated bill date: ${scheduledPretty}`,
        lastLine
      ].filter(Boolean).join("\n"));
    });

    // 5 days AFTER — EXACTLY (once)
    if (isExactlyDaysAfterStr_(today, scheduledStr, 5)) {
      const key = sentKey_(propertyCode, scheduledStr, "A5");
      if (!wasSent_(key)) {
        waterDevLog_(`${propertyCode} sending A5`);
        sendWaterSms_([
          `${propertyName} water reading date passed 5 days ago.`,
          `Estimated bill date: ${scheduledPretty}`,
          lastLine,
          `When the bill comes in, update NextReadingDate.`
        ].filter(Boolean).join("\n"));
        markSent_(key);
      }
    }
  }

  waterDevLog_("END waterDailyCheck");
}

/************** ACTIVE HELPER **************/
function isActive_(v) {
  if (v === true) return true; // checkbox
  const s = String(v || "").trim().toLowerCase();
  return s === "" || s === "true" || s === "yes" || s === "y" || s === "1";
}

/************** SMS SENDER **************/
function sendWaterSmsViaTwilio_(toPhone, message) {
  const props = PropertiesService.getScriptProperties();
  const sid = props.getProperty("TWILIO_SID");
  const token = props.getProperty("TWILIO_TOKEN");
  const from = props.getProperty("TWILIO_NUMBER");

  if (!sid || !token || !from) {
    throw new Error("Missing TWILIO_SID / TWILIO_TOKEN / TWILIO_NUMBER in Script Properties.");
  }

  const url = "https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json";
  const payload = { From: from, To: toPhone, Body: message };

  const options = {
    method: "post",
    payload,
    headers: { Authorization: "Basic " + Utilities.base64Encode(sid + ":" + token) },
    muteHttpExceptions: true
  };

  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();

  if (code < 200 || code >= 300) {
    // log Twilio body for debugging
    waterDevLog_("Twilio error: HTTP " + code + " — " + resp.getContentText());
    throw new Error("Twilio SMS failed: HTTP " + code);
  }
}

function sendWaterSms_(message) {
  if (DEV_MODE) { waterDevLog_("DEV WATER SMS -> " + message); return; }
  sendWaterSmsViaTwilio_(WATER_SMS_TO, message);
}

/************** DATE HELPERS **************/
function todayStr_() {
  return Utilities.formatDate(new Date(), WATER_TZ, "yyyy-MM-dd");
}
function dateStr_(d) {
  return Utilities.formatDate(d, WATER_TZ, "yyyy-MM-dd");
}
function prettyDate_(d) {
  return Utilities.formatDate(d, WATER_TZ, "MM/dd/yy");
}
function addDaysStr_(yyyyMmDd, deltaDays) {
  const [y, m, d] = yyyyMmDd.split("-").map(n => Number(n));
  const dt = new Date(y, m - 1, d, 12, 0, 0); // noon to avoid DST issues
  dt.setDate(dt.getDate() + deltaDays);
  return Utilities.formatDate(dt, WATER_TZ, "yyyy-MM-dd");
}

function sendIfDueDaysBefore_(propertyCode, scheduledStr, code, daysBefore, fnSend) {
  const key = sentKey_(propertyCode, scheduledStr, code);
  if (wasSent_(key)) return;

  const dueStr = addDaysStr_(scheduledStr, -daysBefore);
  if (todayStr_() !== dueStr) return;

  fnSend();
  markSent_(key);
}

function isExactlyDaysAfterStr_(todayStr, scheduledStr, daysAfter) {
  const due = addDaysStr_(scheduledStr, daysAfter);
  return todayStr === due;
}

/************** SEND-ONCE TRACKING **************/
function sentKey_(propertyCode, scheduledStr, code) {
  return `WATER_${propertyCode}_${scheduledStr}_${code}`;
}
function wasSent_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) === "1";
}
function markSent_(key) {
  PropertiesService.getScriptProperties().setProperty(key, "1");
}

/************** DEV LOG **************/
function waterDevLog_(msg) {
  const line = `[WATER] ${Utilities.formatDate(new Date(), WATER_TZ, "yyyy-MM-dd HH:mm:ss")} — ${msg}`;
  try {
    const ss = SpreadsheetApp.openById(WATER_SHEET_ID);
    const sh = ss.getSheetByName(DEVLOG_SHEET_NAME);
    if (sh) sh.appendRow([new Date(), line]);
  } catch (err) {}
  Logger.log(line);
}

/************** TESTS **************/
function TEST_sendWaterNow() {
  sendWaterSms_("Test: water reminders are working ✅");
}

function WATER_resetAllSentKeys() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  let n = 0;

  Object.keys(all).forEach(k => {
    if (k.startsWith("WATER_")) {
      props.deleteProperty(k);
      n++;
    }
  });

  waterDevLog_(`Deleted WATER_ keys: ${n}`);
}
