// ============================================================
// PROPERA — SMS CONSENT FORM HANDLER
// Deploy as: Apps Script > Deploy > Web App
//   - Execute as: Me
//   - Who has access: Anyone
// After deploying, copy the Web App URL into sms-consent.html
// ============================================================

/**
 * Handles POST from the SMS consent form on usepropera.com
 * Saves a timestamped consent record to the "SMS_Consent" sheet tab.
 */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    var ss = SpreadsheetApp.getActive();
    var sheetName = "SMS_Consent";
    var sheet = ss.getSheetByName(sheetName);

    // Create sheet + header row if it doesn't exist
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, 8).setValues([[
        "Timestamp",
        "Full Name",
        "Phone",
        "Property",
        "Consent Given",
        "Consent Text Version",
        "Source URL",
        "IP / User Agent"
      ]]);
      sheet.setFrozenRows(1);
      // Style header
      sheet.getRange(1, 1, 1, 8)
        .setBackground("#05080F")
        .setFontColor("#00F5D4")
        .setFontWeight("bold");
      sheet.setColumnWidth(1, 180); // Timestamp
      sheet.setColumnWidth(2, 150); // Name
      sheet.setColumnWidth(3, 140); // Phone
      sheet.setColumnWidth(4, 180); // Property
      sheet.setColumnWidth(7, 220); // Source URL
      sheet.setColumnWidth(8, 250); // UA
    }

    // Append consent record
    sheet.appendRow([
      new Date(),                                          // Timestamp
      String(data.fullName  || "").trim(),                // Full Name
      String(data.phone     || "").trim(),                // Phone
      String(data.property  || "").trim(),                // Property
      "YES – checkbox checked",                           // Consent Given
      "v1 – Feb 15 2026",                                 // Consent Text Version
      String(data.sourceUrl || "https://usepropera.com/sms-consent"), // Source URL
      String(data.userAgent || "").trim()                 // User Agent
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * GET handler — simple health check so you can verify the endpoint is live.
 * Visit the Web App URL in a browser and you should see {"status":"ok"}
 */
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", service: "Propera SMS Consent Handler" }))
    .setMimeType(ContentService.MimeType.JSON);
}
