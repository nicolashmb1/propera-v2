/**
 * Propera Portal API — Read-only endpoint
 * Deploy as Web App, execute as: Me, who has access: Anyone
 */

var CACHE_KEY = 'portal:tickets:v1';
var CACHE_KEY_PROPERTIES = 'portal:properties:v1';
var CACHE_KEY_TENANTS = 'portal:tenants:v1';
var CACHE_KEY_ACTIVITY = 'portal:activity:v1';
var CACHE_TTL = 30;
/** Sheet name for tenant database (Property, Unit, Phone, Name, etc.). Must be in same spreadsheet. */
var TENANT_SHEET_NAME = 'Tenants';
/** Sheet name for activity/timeline log. Columns: TicketID, Action, By, Time; optional: Color. One row per activity. */
var ACTIVITY_SHEET_NAME = 'Activity';
/** Portal identity + RBAC: join to Staff / StaffAssignments. See portalBuildMePayload_(). */
var PORTAL_USERS_SHEET_NAME = 'Users';
var SR_STAFF_SHEET_NAME_PORTAL = 'Staff';
var SR_CONTACTS_SHEET_NAME_PORTAL = 'Contacts';
var SR_ASSIGNMENTS_SHEET_NAME_PORTAL = 'StaffAssignments';

/**
 * Portal GET dispatcher. Called from PROPERA MAIN.gs doGet(e) when e.parameter.path is set.
 */
function portalDoGet_(e) {
  var path = (e && e.parameter && e.parameter.path) || '';

  var output;

  if (path === 'tickets') {
    output = getTicketsFromSheet();
  } else if (path === 'ticketsOpenDeck') {
    output = getTicketsOpenDeckGrouped_();
  } else if (path === 'properties') {
    output = getPropertiesFromSheet();
  } else if (path === 'tenants') {
    output = getTenantsList();
  } else if (path === 'me') {
    var token = (e && e.parameter && e.parameter.token) ? String(e.parameter.token).trim() : '';
    var emailParam = (e && e.parameter && e.parameter.email) ? String(e.parameter.email).trim().toLowerCase() : '';
    var expectedToken = (typeof ppGet_ === 'function') ? ppGet_('GLOBAL', 'PORTAL_API_TOKEN_PM', '') : '';
    if (token && expectedToken && token === expectedToken && emailParam) {
      output = portalBuildMePayload_(emailParam);
    } else {
      var email = '';
      try {
        email = Session.getActiveUser().getEmail();
      } catch (err) {}
      if (email) {
        output = portalBuildMePayload_(String(email).trim().toLowerCase());
      } else {
        output = { name: 'Team', email: '', role: 'Read-only' };
      }
    }
  } else {
    output = { error: 'unknown path' };
  }

  return json_(output);
}

/**
 * True when ticket should appear in "open / not completed" operational views.
 * Aligns with portal edit semantics (completed / cancelled / resolved closed).
 */
function portalTicketIsOpenForDeck_(status) {
  var s = String(status || '').trim().toLowerCase();
  if (!s) return true;
  if (/^(completed|closed|resolved|cancelled|canceled|done)$/.test(s)) return false; 
}

/**
 * Open tickets only, grouped by property (display name), sorted for mobile deck.
 * Reuses cached Sheet1 read via getTicketsFromSheet().
 */
function getTicketsOpenDeckGrouped_() {
  var all = getTicketsFromSheet();
  if (!Array.isArray(all)) {
    return { ok: false, error: 'tickets_unavailable', groups: [] };
  }

  var open = [];
  for (var i = 0; i < all.length; i++) {
    var t = all[i];
    if (!t) continue;
    if (!portalTicketIsOpenForDeck_(t.status)) continue;
    var tid = String(t.ticketId || '').trim();
    if (!tid) continue;
    open.push(t);
  }

  open.sort(function (a, b) {
    var pa = String(a.property || '').toLowerCase();
    var pb = String(b.property || '').toLowerCase();
    if (pa !== pb) return pa < pb ? -1 : 1;
    var ua = String(a.unit || '').toLowerCase();
    var ub = String(b.unit || '').toLowerCase();
    if (ua !== ub) return ua < ub ? -1 : 1;
    return String(a.ticketId || '').localeCompare(String(b.ticketId || ''));
  });

  var byProp = {};
  for (var j = 0; j < open.length; j++) {
    var row = open[j];
    var propLabel = String(row.property || '').trim() || '(No property)';
    if (!byProp[propLabel]) byProp[propLabel] = [];
    var summaryRaw = String(row.summary || row.message || row.issue || '').trim();
    var subtitle = summaryRaw.length > 140 ? summaryRaw.slice(0, 137) + '…' : summaryRaw;
    var title = propLabel;
    if (String(row.unit || '').trim()) {
      title = propLabel + ' — ' + String(row.unit || '').trim();
    }
    byProp[propLabel].push({
      ticketId: String(row.ticketId || '').trim(),
      title: title,
      subtitle: subtitle,
      status: String(row.status || 'Open').trim() || 'Open',
      property: propLabel,
      unit: String(row.unit || '').trim()
    });
  }

  var keys = Object.keys(byProp).sort(function (a, b) {
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
  var groups = [];
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    groups.push({
      property: key,
      count: byProp[key].length,
      tickets: byProp[key]
    });
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    totalOpen: open.length,
    groups: groups
  };
}

/**
 * PM portal write endpoints: photo upload + ticket creation.
 * Both require PM token (PropertyPolicy GLOBAL / PORTAL_API_TOKEN_PM).
 * Token from query ?token=... or JSON body { token: "..." }.
 * Called from PROPERA MAIN.gs doPost(e) when e.parameter.path is set.
 */
function portalDoPost_(e) {
  var params = e.parameter || {};
  var path = (params.path || '').toString().trim();

  var body = null;
  try {
    if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    return json_({ ok: false, error: 'invalid_json' });
  }

  var token = (params.token || (body && body.token) || '').toString().trim();
  if (!token) {
    try { Logger.log('PORTAL unauthorized: no token'); } catch (_) {}
    return json_({ ok: false, error: 'unauthorized' });
  }

  var expectedToken = (typeof ppGet_ === 'function') ? ppGet_('GLOBAL', 'PORTAL_API_TOKEN_PM', '') : '';
  if (!expectedToken || token !== expectedToken) {
    try { Logger.log('PORTAL unauthorized: token mismatch (expected set=' + (expectedToken ? 'yes' : 'no') + ')'); } catch (_) {}
    return json_({ ok: false, error: 'unauthorized' });
  }

  // Phase 1 instrumentation: unify trace adapter/id for policy/lifecycle timing comparison
  try {
    if (typeof globalThis !== "undefined") {
      globalThis.__traceAdapter = "PORTAL";
      globalThis.__traceId = "PORTAL_PM_" + String(Date.now());
    }
  } catch (_) {}

  if (path === 'pm.uploadAttachment') {
    return handlePmUploadAttachment_(body || {});
  }
  if (path === 'pm.createTicket') {
    try { Logger.log('PORTAL pm.createTicket START prop=' + (body && body.property ? body.property : '') + ' unit=' + (body && body.unit ? body.unit : '')); } catch (_) {}
    portalLogFailsafe_('START', body, '');
    if (typeof logDevSms_ === 'function') {
      try { logDevSms_((body && body.phoneE164) || '(portal)', (body && body.message) ? String(body.message).trim().slice(0, 60) : '', 'PM_CREATE_TICKET_START prop=' + (body && body.property ? body.property : '') + ' unit=' + (body && body.unit ? body.unit : '')); } catch (_) {}
    }
    var out = handlePmCreateTicket_(body || {});
    try { Logger.log('PORTAL pm.createTicket DONE'); } catch (_) {}
    return out;
  }
  if (path === 'pm.updateTicket') {
    return handlePmUpdateTicket_(body || {});
  }
  if (path === 'pm.completeTicket') {
    return handlePmCompleteTicket_(body || {});
  }
  if (path === 'pm.deleteTicket') {
    return handlePmDeleteTicket_(body || {});
  }
  if (path === 'pm.addAttachment') {
    return handlePmAddAttachment_(body || {});
  }
  if (path === 'pm.createProperty') {
    return handlePmCreateProperty_(body || {});
  }
  if (path === 'portal.login') {
    return handlePortalLogin_(body || {});
  }

  return json_({ ok: false, error: 'unknown_path' });
}

/**
 * path=pm.uploadAttachment
 * Body: { token, filename, mimeType, dataBase64, property, unit }
 * Saves to Drive folder "ticket log_Images". Returns { ok, url, fileId, name }. No ticket rows.
 */
function handlePmUploadAttachment_(body) {
  var filename = (body.filename || 'photo.jpg').toString().trim();
  var mimeType = (body.mimeType || 'image/jpeg').toString().trim();
  var dataBase64 = (body.dataBase64 || '').toString().trim();
  var property = (body.property || '').toString().trim().toUpperCase();
  var unit = (body.unit || '').toString().trim();

  if (!dataBase64) {
    return json_({ ok: false, error: 'missing_dataBase64' });
  }

  var blob;
  try {
    blob = Utilities.newBlob(Utilities.base64Decode(dataBase64), mimeType, filename);
  } catch (err) {
    return json_({ ok: false, error: 'invalid_base64' });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ssFile = DriveApp.getFileById(ss.getId());
  var parentFolder = ssFile.getParents().hasNext() ? ssFile.getParents().next() : null;
  if (!parentFolder) {
    return json_({ ok: false, error: 'no_spreadsheet_parent' });
  }

  var folderName = 'ticket log_Images';
  var folder = getOrCreateChildFolder_(parentFolder, folderName);

  var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  var safeProp = property || 'PROP';
  var safeUnit = unit || 'UNIT';
  var baseName = filename.replace(/\.[^.]+$/, '') || 'photo';
  var ext = (filename.match(/\.[^.]+$/) || ['', '.jpg'])[1];
  var fileName = safeProp + '_' + safeUnit + '_' + timestamp + '_' + baseName + ext;

  var file = folder.createFile(blob.setName(fileName));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var fileId = file.getId();
  var url = 'https://drive.google.com/uc?export=view&id=' + fileId;

  if (typeof logDevSms_ === 'function') {
    try { logDevSms_('', '', 'PM_UPLOAD fileId=' + fileId + ' name=' + file.getName() + ' prop=' + property + ' unit=' + unit); } catch (_) {}
  }

  return json_({
    ok: true,
    url: url,
    fileId: fileId,
    name: file.getName()
  });
}

function getOrCreateChildFolder_(parentFolder, folderName) {
  var iter = parentFolder.getFoldersByName(folderName);
  if (iter.hasNext()) return iter.next();
  return parentFolder.createFolder(folderName);
}

/**
 * Failsafe: append one row to sheet "PortalLog" in the script's spreadsheet.
 * So you see activity even if DevSmsLog / LOG_SHEET_ID isn't used or flush fails.
 */
function portalLogFailsafe_(stage, body, detail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return;
    var sh = ss.getSheetByName('PortalLog');
    if (!sh) {
      sh = ss.insertSheet('PortalLog');
      sh.getRange(1, 1, 1, 4).setValues([['Timestamp', 'Stage', 'Payload', 'Detail']]);
    }
    var row = [
      new Date(),
      stage,
      (body && (body.phoneE164 || body.property)) ? (String(body.property || '') + ' ' + String(body.unit || '') + ' ' + (body.message ? String(body.message).slice(0, 40) : '')) : '',
      detail
    ];
    sh.appendRow(row);
  } catch (_) {}
}

/**
 * path=pm.createTicket
 * Delegates to portalPmCreateTicketFromForm_ in PROPERA MAIN; returns brain result.
 * On failure, returns error from result.reason (or err.message) so the app can show it.
 */
function handlePmCreateTicket_(body) {
  try {
    var result = (typeof portalPmCreateTicketFromForm_ === 'function') ? portalPmCreateTicketFromForm_(body) : null;
    if (!result) {
      try { Logger.log('PORTAL createTicket FAIL result=null'); } catch (_) {}
      portalLogFailsafe_('FAIL', body, 'reason=null');
      if (typeof logDevSms_ === 'function') { try { logDevSms_('', '', 'PM_CREATE_TICKET_FAIL reason=null'); } catch (_) {} }
      return json_({ ok: false, error: 'creation_failed', hint: 'Redeploy Web App for detailed errors. Check Apps Script Executions.' });
    }
    if (!result.ok) {
      var errMsg = (result.reason || result.error || 'creation_failed');
      if (errMsg === 'creation_failed') errMsg += ' (check Apps Script Executions for this run)';
      try { Logger.log('PORTAL createTicket FAIL reason=' + (result.reason || result.error || 'creation_failed')); } catch (_) {}
      portalLogFailsafe_('FAIL', body, errMsg);
      if (typeof logDevSms_ === 'function') { try { logDevSms_('', '', 'PM_CREATE_TICKET_FAIL reason=' + (result.reason || result.error || 'creation_failed')); } catch (_) {} }
      return json_({ ok: false, error: errMsg });
    }
    try { Logger.log('PORTAL createTicket OK ticketId=' + (result.ticketId || '') + ' row=' + (result.ticketRow || '')); } catch (_) {}
    portalLogFailsafe_('OK', body, (result.ticketId || '') + ' row=' + (result.ticketRow || ''));
    return json_({
      ok: true,
      ticketId: result.ticketId,
      ticketRow: result.ticketRow,
      workItemId: result.workItemId,
      nextStage: result.nextStage,
      ownerType: result.ownerType,
      ownerId: result.ownerId
    });
  } catch (err) {
    return json_({
      ok: false,
      error: (err && err.message) ? err.message : 'create_ticket_error'
    });
  }
}

/**
 * path=pm.updateTicket
 * Body: { token, ticketId, status?, urgency?, category?, issue?, serviceNote?, schedule? }
 * Delegates to portalPmUpdateTicket_ in PROPERA MAIN.
 */
function handlePmUpdateTicket_(body) {
  try {
    var result = (typeof portalPmUpdateTicket_ === 'function') ? portalPmUpdateTicket_(body) : null;
    if (!result) return json_({ ok: false, error: 'update_failed', hint: 'portalPmUpdateTicket_ not found' });
    if (!result.ok) return json_({ ok: false, error: result.reason || result.error || 'update_failed' });
    return json_({ ok: true, ticketId: result.ticketId });
  } catch (err) {
    return json_({ ok: false, error: (err && err.message) ? err.message : 'update_ticket_error' });
  }
}

/**
 * path=pm.completeTicket
 * Body: { token, ticketId }
 * Delegates to portalPmCompleteTicket_ in PROPERA MAIN.
 */
function handlePmCompleteTicket_(body) {
  try {
    var result = (typeof portalPmCompleteTicket_ === 'function') ? portalPmCompleteTicket_(body) : null;
    if (!result) return json_({ ok: false, error: 'completion_failed', hint: 'portalPmCompleteTicket_ not found' });
    if (!result.ok) return json_({ ok: false, error: result.reason || result.error || 'completion_failed' });
    return json_({ ok: true, ticketId: result.ticketId });
  } catch (err) {
    return json_({ ok: false, error: (err && err.message) ? err.message : 'complete_ticket_error' });
  }
}

/**
 * path=pm.deleteTicket
 * Body: { token, ticketId }
 * Delegates to portalPmDeleteTicket_ in PROPERA MAIN.
 */
function handlePmDeleteTicket_(body) {
  try {
    var result = (typeof portalPmDeleteTicket_ === 'function') ? portalPmDeleteTicket_(body) : null;
    if (!result) return json_({ ok: false, error: 'delete_failed', hint: 'portalPmDeleteTicket_ not found' });
    if (!result.ok) return json_({ ok: false, error: result.reason || result.error || 'delete_failed' });
    return json_({ ok: true, ticketId: result.ticketId });
  } catch (err) {
    return json_({ ok: false, error: (err && err.message) ? err.message : 'delete_ticket_error' });
  }
}

/**
 * path=pm.createProperty
 * Body: { token, propertyName, ticketPrefix, address, shortName? }
 * Appends one row to the "Properties" sheet. Headers are detected on row 1 (same as getPropertiesFromSheet).
 * Ticket prefix must be unique among existing rows (case-insensitive). PropertyID is generated if the sheet has that column.
 */
function handlePmCreateProperty_(body) {
  try {
    var name = (body.propertyName || body.name || '').toString().trim();
    var prefixRaw = (body.ticketPrefix || body.propertyCode || '').toString().trim();
    var prefix = prefixRaw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    var address = (body.address || '').toString().trim();
    var shortNameOpt = (body.shortName || '').toString().trim();

    if (!name) {
      return json_({ ok: false, error: 'missing_propertyName' });
    }
    if (!prefix || prefix.length < 2) {
      return json_({ ok: false, error: 'invalid_ticketPrefix', hint: 'Use at least 2 letters/numbers, e.g. MORR' });
    }
    if (!address) {
      return json_({ ok: false, error: 'missing_address' });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('Properties');
    if (!sh) {
      return json_({ ok: false, error: 'no_properties_sheet' });
    }

    var data = sh.getDataRange().getValues();
    if (!data || data.length < 1) {
      return json_({ ok: false, error: 'properties_sheet_empty' });
    }

    var headers = data[0].map(function(h) {
      return String(h || '').trim().toLowerCase();
    });

    function colIndex(names) {
      for (var n = 0; n < names.length; n++) {
        var j = headers.indexOf(names[n]);
        if (j >= 0) return j;
      }
      return -1;
    }

    var idCol = colIndex(['propertyid', 'property_id']);
    var nameCol = colIndex(['propertyname', 'property']);
    var prefixCol = colIndex(['ticketprefix', 'propertycode']);
    var shortCol = colIndex(['shortname', 'displayname']);
    var addrCol = colIndex(['address', 'propertyaddress']);
    var activeCol = colIndex(['active']);

    if (nameCol < 0 || prefixCol < 0) {
      return json_({ ok: false, error: 'properties_header_mismatch', hint: 'Need PropertyName (or Property) and TicketPrefix (or PropertyCode) columns' });
    }
    if (addrCol < 0) {
      return json_({ ok: false, error: 'properties_sheet_missing_address', hint: 'Add an Address (or PropertyAddress) column to the Properties sheet' });
    }

    for (var r = 1; r < data.length; r++) {
      var existing = String(data[r][prefixCol] || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (existing && existing === prefix) {
        return json_({ ok: false, error: 'duplicate_ticketPrefix', hint: 'That ticket prefix is already used' });
      }
    }

    var newPropertyId = 'P-' + Utilities.getUuid().replace(/-/g, '').substring(0, 12).toUpperCase();
    var displayShort = shortNameOpt;
    if (!displayShort && prefix) {
      displayShort = prefix.charAt(0) + prefix.slice(1).toLowerCase();
    }

    var numCols = headers.length;
    var newRow = [];
    for (var c = 0; c < numCols; c++) {
      newRow.push('');
    }
    if (idCol >= 0) newRow[idCol] = newPropertyId;
    newRow[nameCol] = name;
    newRow[prefixCol] = prefix;
    if (shortCol >= 0) newRow[shortCol] = displayShort;
    if (addrCol >= 0) newRow[addrCol] = address;
    if (activeCol >= 0) newRow[activeCol] = true;

    sh.appendRow(newRow);

    try {
      CacheService.getScriptCache().remove(CACHE_KEY_PROPERTIES);
    } catch (e1) {}

    try {
      portalLogFailsafe_('CREATE_PROPERTY', { property: name, ticketPrefix: prefix }, newPropertyId);
    } catch (e2) {}

    return json_({
      ok: true,
      propertyId: newPropertyId,
      name: name,
      ticketPrefix: prefix,
      shortName: displayShort
    });
  } catch (err) {
    return json_({
      ok: false,
      error: (err && err.message) ? err.message : 'create_property_error'
    });
  }
}

/**
 * path=pm.addAttachment
 * Body: { token, ticketId, attachments: [url1, url2, ...] }
 * Appends attachment URLs to existing ticket. Delegates to portalPmAddAttachmentToTicket_ in PROPERA MAIN.
 */
function handlePmAddAttachment_(body) {
  try {
    var ticketId = (body.ticketId || '').toString().trim();
    var attachments = body.attachments;
    if (!ticketId) return json_({ ok: false, error: 'missing_ticketId' });
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return json_({ ok: false, error: 'attachments_required' });
    }
    var valid = attachments.filter(function (u) { return typeof u === 'string' && String(u).trim().length > 0; });
    if (valid.length === 0) return json_({ ok: false, error: 'attachments_required' });
    var result = (typeof portalPmAddAttachmentToTicket_ === 'function') ? portalPmAddAttachmentToTicket_({ ticketId: ticketId, attachments: valid }) : null;
    if (!result) return json_({ ok: false, error: 'add_attachment_failed', hint: 'portalPmAddAttachmentToTicket_ not found' });
    if (!result.ok) return json_({ ok: false, error: result.reason || result.error || 'add_attachment_failed' });
    return json_({
      ok: true,
      ticketId: result.ticketId,
      ticketRow: result.ticketRow,
      attachments: result.attachments,
      addedCount: result.addedCount
    });
  } catch (err) {
    return json_({ ok: false, error: (err && err.message) ? err.message : 'add_attachment_error' });
  }
}

// ─── Portal Users ↔ Staff ↔ StaffAssignments (Propera linkage) ─────────────

function portalSheetHeaderMap_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var raw = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < raw.length; i++) {
    var h = String(raw[i] || '').trim();
    if (!h) continue;
    var key = h.toLowerCase().replace(/\s+/g, '');
    map[key] = i;
  }
  return map;
}

function portalCol_(map, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var k = String(candidates[i] || '').toLowerCase().replace(/\s+/g, '');
    if (map[k] !== undefined) return map[k];
  }
  return -1;
}

/** Accepts SelectPropertyCode or legacy typo SlectPropertyCode. */
function portalUsersSelectPropertyCodeCol_(map) {
  var a = portalCol_(map, ['SelectPropertyCode']);
  if (a >= 0) return a;
  return portalCol_(map, ['SlectPropertyCode']);
}

/**
 * SHA-256 hex (lowercase). Pepper in Script properties: PORTAL_PASSWORD_PEPPER
 * Precompute hash for sheet: same algorithm in Node or openssl; pepper must match.
 */
function portalHashPassword_(email, password) {
  var props = PropertiesService.getScriptProperties();
  var pepper = props.getProperty('PORTAL_PASSWORD_PEPPER') || 'propera-portal-pepper-set-PORTAL_PASSWORD_PEPPER';
  var raw = pepper + String(email).toLowerCase().trim() + String(password);
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < digest.length; i++) {
    var b = digest[i];
    if (b < 0) b += 256;
    hex += ('0' + b.toString(16)).slice(-2);
  }
  return hex.toLowerCase();
}

function portalFindUserRowByEmail_(email) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(PORTAL_USERS_SHEET_NAME);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (!data || data.length < 2) return null;
  var map = portalSheetHeaderMap_(sh);
  var emailCol = portalCol_(map, ['Email']);
  if (emailCol < 0) return null;
  var want = String(email || '').trim().toLowerCase();
  for (var r = 1; r < data.length; r++) {
    var cell = String(data[r][emailCol] || '').trim().toLowerCase();
    if (cell === want) {
      return { sheet: sh, rowIndex: r, row: data[r], map: map };
    }
  }
  return null;
}

function portalGetStaffRow_(staffId) {
  var id = String(staffId || '').trim();
  if (!id) return null;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SR_STAFF_SHEET_NAME_PORTAL);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (!data || data.length < 2) return null;
  var map = portalSheetHeaderMap_(sh);
  var sidCol = portalCol_(map, ['StaffId']);
  var nameCol = portalCol_(map, ['StaffName', 'Name']);
  var contactCol = portalCol_(map, ['ContactId', 'ContactID']);
  var activeCol = portalCol_(map, ['Active']);
  if (sidCol < 0) return null;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][sidCol] || '').trim() !== id) continue;
    return {
      staffId: id,
      staffName: nameCol >= 0 ? String(data[r][nameCol] || '').trim() : '',
      contactId: contactCol >= 0 ? String(data[r][contactCol] || '').trim() : '',
      active: activeCol >= 0 ? data[r][activeCol] : true
    };
  }
  return null;
}

function portalGetContactPhone_(contactId) {
  var cid = String(contactId || '').trim();
  if (!cid) return '';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SR_CONTACTS_SHEET_NAME_PORTAL);
  if (!sh) return '';
  var data = sh.getDataRange().getValues();
  if (!data || data.length < 2) return '';
  var map = portalSheetHeaderMap_(sh);
  var idCol = portalCol_(map, ['ContactID', 'ContactId']);
  var phoneCol = portalCol_(map, ['PhoneE164', 'Phone']);
  if (idCol < 0) return '';
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol] || '').trim() === cid) {
      return phoneCol >= 0 ? String(data[r][phoneCol] || '').trim() : '';
    }
  }
  return '';
}

function portalGetAssignmentsForStaff_(staffId) {
  var id = String(staffId || '').trim();
  var list = [];
  if (!id) return list;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SR_ASSIGNMENTS_SHEET_NAME_PORTAL);
  if (!sh) return list;
  var data = sh.getDataRange().getValues();
  if (!data || data.length < 2) return list;
  var map = portalSheetHeaderMap_(sh);
  var sidCol = portalCol_(map, ['StaffId']);
  var pidCol = portalCol_(map, ['PropertyId']);
  var pcodeCol = portalCol_(map, ['PropertyCode']);
  var domainCol = portalCol_(map, ['Domain']);
  var roleCol = portalCol_(map, ['RoleType', 'Role']);
  var activeCol = portalCol_(map, ['Active']);
  if (sidCol < 0) return list;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][sidCol] || '').trim() !== id) continue;
    var active = activeCol >= 0 ? data[r][activeCol] : true;
    if (active === false || String(active).toLowerCase() === 'false') continue;
    list.push({
      propertyId: pidCol >= 0 ? String(data[r][pidCol] || '').trim() : '',
      propertyCode: pcodeCol >= 0 ? String(data[r][pcodeCol] || '').trim().toUpperCase() : '',
      domain: domainCol >= 0 ? String(data[r][domainCol] || '').trim() : '',
      roleType: roleCol >= 0 ? String(data[r][roleCol] || '').trim() : ''
    });
  }
  return list;
}

/**
 * Full portal profile: Users row + Staff + Contacts + StaffAssignments.
 * propertyScopeSource: "assignments" when StaffAssignments drive the property list; "users" when only Users Select*; "none" otherwise.
 */
function portalBuildMePayload_(email) {
  var em = String(email || '').trim().toLowerCase();
  var firstName = 'Team';
  if (em && em.indexOf('@') > 0) {
    var local = em.split('@')[0].split('.')[0];
    if (local) firstName = local.charAt(0).toUpperCase() + local.slice(1);
  }
  var base = {
    name: firstName,
    email: em,
    role: 'Read-only',
    staffId: '',
    staffName: '',
    contactPhone: '',
    selectPropertyId: '',
    selectPropertyCode: '',
    allowedPropertyIds: [],
    allowedProperties: [],
    defaultPropertyId: '',
    defaultPropertyCode: '',
    propertyScopeSource: 'none',
    updatedAt: ''
  };
  var found = portalFindUserRowByEmail_(em);
  if (!found) return base;

  var row = found.row;
  var map = found.map;
  var roleCol = portalCol_(map, ['Role']);
  var staffIdCol = portalCol_(map, ['StaffId']);
  var selPidCol = portalCol_(map, ['SelectPropertyID']);
  var selPcodeCol = portalUsersSelectPropertyCodeCol_(map);
  var activeCol = portalCol_(map, ['Active']);
  var updatedCol = portalCol_(map, ['UpdateAt', 'UpdatedAt']);

  var role = roleCol >= 0 ? String(row[roleCol] || '').trim() : '';
  var staffId = staffIdCol >= 0 ? String(row[staffIdCol] || '').trim() : '';
  var selPid = selPidCol >= 0 ? String(row[selPidCol] || '').trim() : '';
  var selPcode = selPcodeCol >= 0 ? String(row[selPcodeCol] || '').trim().toUpperCase() : '';
  var uActive = activeCol >= 0 ? row[activeCol] : true;
  var updatedAt = updatedCol >= 0 ? String(row[updatedCol] || '').trim() : '';

  if (role) base.role = role;
  base.staffId = staffId;
  base.selectPropertyId = selPid;
  base.selectPropertyCode = selPcode;
  base.updatedAt = updatedAt;
  if (uActive === false || String(uActive).toLowerCase() === 'false') {
    base.role = 'Inactive';
  }

  var staff = staffId ? portalGetStaffRow_(staffId) : null;
  if (staff && staff.staffName) {
    base.name = staff.staffName;
    base.staffName = staff.staffName;
  }
  if (staff && staff.contactId) {
    base.contactPhone = portalGetContactPhone_(staff.contactId);
  }

  var assignments = staffId ? portalGetAssignmentsForStaff_(staffId) : [];
  var allowedProps = [];
  var seen = {};
  for (var i = 0; i < assignments.length; i++) {
    var a = assignments[i];
    var pid = a.propertyId || '';
    var pc = a.propertyCode || '';
    var key = (pid + '|' + pc).toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    if (pid || pc) {
      allowedProps.push({ propertyId: pid, propertyCode: pc, domain: a.domain, roleType: a.roleType });
    }
  }

  base.allowedProperties = allowedProps;
  var allowedIds = [];
  for (var j = 0; j < allowedProps.length; j++) {
    if (allowedProps[j].propertyId) allowedIds.push(allowedProps[j].propertyId);
  }
  base.allowedPropertyIds = allowedIds;

  if (allowedProps.length > 0) {
    base.propertyScopeSource = 'assignments';
    var defPid = '';
    var defCode = '';
    if (selPid && allowedIds.indexOf(selPid) >= 0) {
      defPid = selPid;
    } else if (selPcode) {
      var want = String(selPcode).toUpperCase();
      for (var k = 0; k < allowedProps.length; k++) {
        if (String(allowedProps[k].propertyCode || '').toUpperCase() === want) {
          defPid = allowedProps[k].propertyId;
          defCode = allowedProps[k].propertyCode;
          break;
        }
      }
    }
    if (!defPid && allowedProps.length > 0) {
      defPid = allowedProps[0].propertyId;
      defCode = allowedProps[0].propertyCode;
    } else if (!defCode && defPid) {
      for (var m = 0; m < allowedProps.length; m++) {
        if (allowedProps[m].propertyId === defPid) {
          defCode = allowedProps[m].propertyCode;
          break;
        }
      }
    }
    base.defaultPropertyId = defPid;
    base.defaultPropertyCode = defCode;
  } else if (selPid || selPcode) {
    base.propertyScopeSource = 'users';
    base.defaultPropertyId = selPid;
    base.defaultPropertyCode = selPcode;
  }

  return base;
}

/**
 * path=portal.login (POST, same PM token as other portal writes)
 * Body: { token, email, password }
 * Users sheet: PasswordHash = hex SHA-256 of PORTAL_PASSWORD_PEPPER + email + password
 */
function handlePortalLogin_(body) {
  try {
    var email = (body.email || '').toString().trim().toLowerCase();
    var password = (body.password || '').toString();
    if (!email || !password) {
      return json_({ ok: false, error: 'missing_credentials' });
    }
    var found = portalFindUserRowByEmail_(email);
    if (!found) {
      return json_({ ok: false, error: 'invalid_credentials' });
    }
    var row = found.row;
    var umap = found.map;
    var hashCol = portalCol_(umap, ['PasswordHash', 'password_hash']);
    if (hashCol < 0) {
      return json_({ ok: false, error: 'password_not_configured' });
    }
    var storedHash = String(row[hashCol] || '').trim().toLowerCase();
    if (!storedHash) {
      return json_({ ok: false, error: 'password_not_set' });
    }
    var computed = portalHashPassword_(email, password);
    if (computed !== storedHash) {
      return json_({ ok: false, error: 'invalid_credentials' });
    }
    var activeCol = portalCol_(umap, ['Active']);
    if (activeCol >= 0) {
      var ac = row[activeCol];
      if (ac === false || String(ac).toLowerCase() === 'false') {
        return json_({ ok: false, error: 'account_inactive' });
      }
    }
    var me = portalBuildMePayload_(email);
    return json_({
      ok: true,
      name: me.name,
      email: me.email,
      role: me.role,
      staffId: me.staffId,
      staffName: me.staffName,
      contactPhone: me.contactPhone,
      selectPropertyId: me.selectPropertyId,
      selectPropertyCode: me.selectPropertyCode,
      allowedPropertyIds: me.allowedPropertyIds,
      allowedProperties: me.allowedProperties,
      defaultPropertyId: me.defaultPropertyId,
      defaultPropertyCode: me.defaultPropertyCode,
      propertyScopeSource: me.propertyScopeSource,
      updatedAt: me.updatedAt
    });
  } catch (err) {
    return json_({ ok: false, error: (err && err.message) ? err.message : 'login_error' });
  }
}

/**
 * Returns JSON response using ContentService
 */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Reads tickets from Sheet1 only. First row = header.
 * Single getDataRange().getValues() read, in-memory mapping. CacheService 30s TTL.
 */
function getTicketsFromSheet() {
  var t0 = new Date().getTime();
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY);
  if (cached) {
    try {
      var out = JSON.parse(cached);
      console.log('[portal:tickets] cache hit, ' + (new Date().getTime() - t0) + 'ms');
      return out;
    } catch (e) {
      // invalid cache, fall through to rebuild
    }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Sheet1');
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return [];

  var headers = data[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
  var col = function(name) {
    var i = headers.indexOf(name);
    return i >= 0 ? i : -1;
  };

  var ticketIdCol = col('ticketid') >= 0 ? col('ticketid') : col('ticket_id') >= 0 ? col('ticket_id') : col('id');
  var propertyCol = col('property') >= 0 ? col('property') : col('prop');
  var unitCol = col('unit');
  var statusCol = col('status');
  var categoryCol = col('category');
  var categoryFinalCol = col('categoryfinal');
  var priorityCol = col('urgency') >= 0 ? col('urgency') : (col('priority') >= 0 ? col('priority') : -1);
  // Canonical editable issue field in Sheet1 is Message (COL.MSG in backend). Issue column is optional; if missing, issue = message.
  var messageCol = col('message') >= 0 ? col('message') : -1;
  var issueCol = col('issue') >= 0 ? col('issue') : -1;
  var assignToCol = col('assignto') >= 0 ? col('assignto') : -1;
  var createdAtCol = col('createdat') >= 0 ? col('createdat') : col('created_at');
  var timestampCol = col('timestamp') >= 0 ? col('timestamp') : -1;
  var closedAtCol = col('closedat') >= 0 ? col('closedat') : -1;
  var updatedAtCol = col('lastupdatedat') >= 0 ? col('lastupdatedat') : col('updatedat') >= 0 ? col('updatedat') : col('updated_at');
  var attachmentsCol = col('attachments') >= 0 ? col('attachments') : -1;
  // Sheet1: ServiceNote (no 's'), PreferredWindow — match exact header lowercased + common variants
  var serviceNotesCol = col('servicenote') >= 0 ? col('servicenote') : (col('servicenotes') >= 0 ? col('servicenotes') : (col('service notes') >= 0 ? col('service notes') : -1));
  var prefWindowCol = col('preferredwindow') >= 0 ? col('preferredwindow') : (col('preferred window') >= 0 ? col('preferred window') : -1);

  /**
   * Parse attachment column: keep full URLs (http/https) and paths (e.g. "ticket log_Images/MORR-xxx.jpg").
   * Split only on comma or newline so paths with spaces (e.g. "ticket log_Images/...") stay as one attachment.
   * Paths are resolved to Google Drive view URLs when possible so the app can display images.
   */
  function parseAttachmentUrls(val) {
    if (val == null || val === '') return [];
    var s = String(val).trim();
    if (!s) return [];
    var parts = s.split(/[,\n]+/).map(function(p) { return p.trim(); }).filter(Boolean);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var u = parts[i];
      if (!u) continue;
      if (u.indexOf('http://') === 0 || u.indexOf('https://') === 0) {
        out.push(u);
      } else {
        var resolved = resolveAttachmentPathToDriveUrl(u);
        out.push(resolved || u);
      }
    }
    return out;
  }

  /**
   * If path looks like "folder/filename.jpg", try to find the file in Drive (spreadsheet's parent or sibling folder) and return a view URL.
   * Folder must be next to the spreadsheet (same parent). For the image to load in the app, share the file/folder with "Anyone with the link".
   * Returns null if not found so the frontend still gets the original path.
   */
  function resolveAttachmentPathToDriveUrl(path) {
    try {
      var pathStr = String(path).trim();
      if (!pathStr || pathStr.indexOf('http') === 0) return pathStr;
      var segments = pathStr.split('/').filter(Boolean);
      if (segments.length === 0) return null;
      var fileName = segments[segments.length - 1];
      var drive = DriveApp;
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var ssFile = drive.getFileById(ss.getId());
      var parent = ssFile.getParents().hasNext() ? ssFile.getParents().next() : null;
      if (!parent) return null;
      var folder = parent;
      for (var i = 0; i < segments.length - 1; i++) {
        var folderName = segments[i];
        var folders = folder.getFoldersByName(folderName);
        if (!folders.hasNext()) return null;
        folder = folders.next();
      }
      var files = folder.getFilesByName(fileName);
      if (!files.hasNext()) return null;
      var file = files.next();
      var id = file.getId();
      return 'https://drive.google.com/uc?export=view&id=' + id;
    } catch (e) {
      return null;
    }
  }

  var tickets = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var msg = messageCol >= 0 ? String(row[messageCol] || '').trim() : '';
    var iss = issueCol >= 0 ? String(row[issueCol] || '').trim() : '';
    // List preview: Message (MSG) is canonical. Only append Issue when it adds info not already in Message
    // (avoids "…full body… | …duplicate title line" when Issue repeats a line from MSG).
    var summaryVal = msg || iss;
    if (msg && iss) {
      var issTrim = String(iss).trim();
      if (issTrim && msg.toLowerCase().indexOf(issTrim.toLowerCase()) < 0) {
        summaryVal = msg + ' | ' + issTrim;
      } else {
        summaryVal = msg;
      }
    }
    var createdVal = createdAtCol >= 0 ? String(row[createdAtCol] || '').trim() : '';
    if (!createdVal && timestampCol >= 0) createdVal = String(row[timestampCol] || '').trim();
    var attachments = attachmentsCol >= 0 ? parseAttachmentUrls(row[attachmentsCol]) : [];
    tickets.push({
      ticketId: ticketIdCol >= 0 ? String(row[ticketIdCol] || '') : '',
      property: propertyCol >= 0 ? String(row[propertyCol] || '') : '',
      unit: unitCol >= 0 ? String(row[unitCol] || '') : '',
      status: statusCol >= 0 ? String(row[statusCol] || '') : '',
      category: (function() {
        var cat = categoryCol >= 0 ? String(row[categoryCol] || '').trim() : '';
        var catFinal = categoryFinalCol >= 0 ? String(row[categoryFinalCol] || '').trim() : '';
        return cat !== '' ? cat : catFinal;
      })(),
      priority: priorityCol >= 0 ? String(row[priorityCol] || '') : '',
      summary: summaryVal,
      message: messageCol >= 0 ? String(row[messageCol] || '').trim() : '',
      issue: issueCol >= 0 ? String(row[issueCol] || '').trim() : '',
      serviceNotes: serviceNotesCol >= 0 ? String(row[serviceNotesCol] || '').trim() : '',
      preferredWindow: prefWindowCol >= 0 ? String(row[prefWindowCol] || '').trim() : '',
      assignee: assignToCol >= 0 ? String(row[assignToCol] || '') : '',
      createdAt: createdVal,
      closedAt: closedAtCol >= 0 ? String(row[closedAtCol] || '').trim() : '',
      updatedAt: updatedAtCol >= 0 ? String(row[updatedAtCol] || '') : '',
      attachments: attachments
    });
  }

  // Enrich with tenant data from tenant database (Property + Unit lookup)
  var tenantMap = getTenantsLookup();
  var activityMap = getActivityLookup();
  for (var i = 0; i < tickets.length; i++) {
    var t = tickets[i];
    var prop = String(t.property || '').trim();
    var unit = String(t.unit || '').trim();
    var key = (prop + '|' + unit).toLowerCase();
    t.tenant = tenantMap[key] || { name: '', phone: '', email: '' };
    var tid = String(t.ticketId || '').trim();
    t.timeline = activityMap[tid] || [];
  }

  try {
    cache.put(CACHE_KEY, JSON.stringify(tickets), CACHE_TTL);
  } catch (e) {
    // payload too large for cache, skip
  }
  console.log('[portal:tickets] built ' + tickets.length + ' rows, ' + (new Date().getTime() - t0) + 'ms');
  return tickets;
}

/**
 * Reads tenant database sheet and returns a lookup map: key = "property|unit" (lowercase), value = { name, phone, email }.
 * Sheet columns: Property, Unit, Phone, Name; optional: Email. Uses TENANT_SHEET_NAME (default "Tenants").
 */
function getTenantsLookup() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY_TENANTS);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {}
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TENANT_SHEET_NAME);
  if (!sheet) return {};

  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return {};

  var headers = data[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
  var col = function(name) {
    var i = headers.indexOf(name);
    return i >= 0 ? i : -1;
  };

  var propertyCol = col('property') >= 0 ? col('property') : -1;
  var unitCol = col('unit') >= 0 ? col('unit') : -1;
  var phoneCol = col('phone') >= 0 ? col('phone') : -1;
  var nameCol = col('name') >= 0 ? col('name') : (col('lastname') >= 0 ? col('lastname') : -1);
  var emailCol = col('email') >= 0 ? col('email') : -1;

  if (propertyCol < 0 || unitCol < 0) return {};
  var map = {};
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var prop = String(row[propertyCol] || '').trim();
    var unit = String(row[unitCol] || '').trim();
    if (!prop && !unit) continue;
    var key = (prop + '|' + unit).toLowerCase();
    var name = nameCol >= 0 ? String(row[nameCol] || '').trim() : '';
    var phone = phoneCol >= 0 ? String(row[phoneCol] || '').trim() : '';
    var email = emailCol >= 0 ? String(row[emailCol] || '').trim() : '';
    map[key] = { name: name, phone: phone, email: email };
  }

  try {
    cache.put(CACHE_KEY_TENANTS, JSON.stringify(map), CACHE_TTL);
  } catch (e) {}
  return map;
}

/**
 * Returns tenant database as an array for portal dropdowns.
 * Each item: { property, unit, phone, name, email }.
 * Property/unit are as stored in the sheet (case preserved for display).
 */
function getTenantsList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TENANT_SHEET_NAME);
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return [];

  var headers = data[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
  var col = function(name) {
    var i = headers.indexOf(name);
    return i >= 0 ? i : -1;
  };

  var propertyCol = col('property') >= 0 ? col('property') : -1;
  var unitCol = col('unit') >= 0 ? col('unit') : -1;
  var phoneCol = col('phone') >= 0 ? col('phone') : -1;
  var nameCol = col('name') >= 0 ? col('name') : (col('lastname') >= 0 ? col('lastname') : -1);
  var emailCol = col('email') >= 0 ? col('email') : -1;

  if (propertyCol < 0 || unitCol < 0) return [];

  var list = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var prop = String(row[propertyCol] || '').trim();
    var unit = String(row[unitCol] || '').trim();
    var phone = phoneCol >= 0 ? String(row[phoneCol] || '').trim() : '';
    var name = nameCol >= 0 ? String(row[nameCol] || '').trim() : '';
    var email = emailCol >= 0 ? String(row[emailCol] || '').trim() : '';
    if (!phone && !name) continue;
    list.push({ property: prop, unit: unit, phone: phone, name: name, email: email });
  }
  return list;
}

/**
 * Reads Activity sheet and returns a lookup map: key = ticketId (trimmed), value = array of { action, by, time, color }.
 * Sheet columns: TicketID (or ticket_id), Action, By, Time; optional: Color. One row per activity; order preserved.
 */
function getActivityLookup() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY_ACTIVITY);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {}
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ACTIVITY_SHEET_NAME);
  if (!sheet) return {};

  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return {};

  var headers = data[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
  var col = function(name) {
    var i = headers.indexOf(name);
    return i >= 0 ? i : -1;
  };

  var ticketIdCol = col('ticketid') >= 0 ? col('ticketid') : col('ticket_id');
  var actionCol = col('action') >= 0 ? col('action') : -1;
  var byCol = col('by') >= 0 ? col('by') : -1;
  var timeCol = col('time') >= 0 ? col('time') : -1;
  var colorCol = col('color') >= 0 ? col('color') : -1;

  if (ticketIdCol < 0 || actionCol < 0) return {};
  var map = {};
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var ticketId = String(row[ticketIdCol] || '').trim();
    if (!ticketId) continue;
    var action = actionCol >= 0 ? String(row[actionCol] || '').trim() : '';
    var by = byCol >= 0 ? String(row[byCol] || '').trim() : 'System';
    var time = timeCol >= 0 ? String(row[timeCol] || '').trim() : '';
    var color = colorCol >= 0 ? String(row[colorCol] || '').trim() : 'var(--accent)';
    if (!color) color = 'var(--accent)';
    if (!map[ticketId]) map[ticketId] = [];
    map[ticketId].push({ action: action, by: by, time: time, color: color });
  }

  try {
    cache.put(CACHE_KEY_ACTIVITY, JSON.stringify(map), CACHE_TTL);
  } catch (e) {}
  return map;
}

/**
 * Reads properties from Properties sheet. Computes open/urgent/units from Sheet1 (tickets).
 * Properties sheet columns: PropertyID, PropertyCode, PropertyName, Active, Address, TicketPrefix
 */
function getPropertiesFromSheet() {
  var t0 = new Date().getTime();
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY_PROPERTIES);
  if (cached) {
    try {
      var out = JSON.parse(cached);
      console.log('[portal:properties] cache hit, ' + (new Date().getTime() - t0) + 'ms');
      return out;
    } catch (e) {}
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var propSheet = ss.getSheetByName('Properties');
  if (!propSheet) return [];

  var propData = propSheet.getDataRange().getValues();
  if (!propData || propData.length < 2) return [];

  var tickets = getTicketsFromSheet();
  var propHeaders = propData[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
  var pCol = function(name) {
    var i = propHeaders.indexOf(name);
    return i >= 0 ? i : -1;
  };

  var idCol = pCol('propertyid') >= 0 ? pCol('propertyid') : -1;
  var nameCol = pCol('propertyname') >= 0 ? pCol('propertyname') : pCol('property');
  var prefixCol = pCol('ticketprefix') >= 0 ? pCol('ticketprefix') : pCol('propertycode');
  var shortCol = pCol('shortname') >= 0 ? pCol('shortname') : (pCol('displayname') >= 0 ? pCol('displayname') : -1);
  var addrCol = pCol('address') >= 0 ? pCol('address') : (pCol('propertyaddress') >= 0 ? pCol('propertyaddress') : -1);
  var activeCol = pCol('active');

  var unitsByPropId = {};
  var occupiedByPropId = {};
  var unitsSheet = ss.getSheetByName('Units');
  if (unitsSheet) {
    var unitsData = unitsSheet.getDataRange().getValues();
    if (unitsData && unitsData.length >= 2) {
      var uHeaders = unitsData[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
      var uPropIdCol = uHeaders.indexOf('propertyid') >= 0 ? uHeaders.indexOf('propertyid') : -1;
      var uStatusCol = uHeaders.indexOf('status') >= 0 ? uHeaders.indexOf('status') : -1;
      if (uPropIdCol >= 0) {
        for (var u = 1; u < unitsData.length; u++) {
          var propId = String(unitsData[u][uPropIdCol] || '').trim();
          if (!propId) continue;
          unitsByPropId[propId] = (unitsByPropId[propId] || 0) + 1;
          if (uStatusCol >= 0) {
            var st = String(unitsData[u][uStatusCol] || '').trim().toLowerCase();
            if (st === 'occupied') occupiedByPropId[propId] = (occupiedByPropId[propId] || 0) + 1;
          }
        }
      }
    }
  }

  var prefixToName = {};
  for (var r = 1; r < propData.length; r++) {
    var row = propData[r];
    var active = activeCol >= 0 ? row[activeCol] : true;
    if (active === false || String(active).toLowerCase() === 'false') continue;
    var name = nameCol >= 0 ? String(row[nameCol] || '').trim() : '';
    var prefix = prefixCol >= 0 ? String(row[prefixCol] || '').trim().toUpperCase() : '';
    if (name && prefix) prefixToName[prefix] = name;
  }

  function resolvePropName(tk) {
    var propName = String(tk.property || '').trim();
    if (propName) return propName;
    var ticketId = String(tk.ticketId || '').trim();
    if (ticketId) {
      var dashIdx = ticketId.indexOf('-');
      var prefix = dashIdx > 0 ? ticketId.substring(0, dashIdx).toUpperCase() : ticketId.toUpperCase();
      if (prefixToName[prefix]) return prefixToName[prefix];
    }
    return propName;
  }

  var openByProp = {};
  var urgentByProp = {};
  var unitsByProp = {};
  var closedStatuses = ['completed', 'canceled', 'resolved'];
  var urgentPriorities = ['high', 'urgent'];

  for (var t = 0; t < tickets.length; t++) {
    var tk = tickets[t];
    var propName = resolvePropName(tk);
    if (!propName) continue;

    var status = String(tk.status || '').toLowerCase();
    var priority = String(tk.priority || '').toLowerCase();
    var isOpen = closedStatuses.indexOf(status) < 0;
    var isUrgent = urgentPriorities.indexOf(priority) >= 0;

    openByProp[propName] = (openByProp[propName] || 0) + (isOpen ? 1 : 0);
    if (isOpen && isUrgent) urgentByProp[propName] = (urgentByProp[propName] || 0) + 1;

    var unit = String(tk.unit || '').trim();
    if (unit) {
      unitsByProp[propName] = unitsByProp[propName] || {};
      unitsByProp[propName][unit] = true;
    }
  }

  var result = [];
  for (var r = 1; r < propData.length; r++) {
    var row = propData[r];
    var active = activeCol >= 0 ? row[activeCol] : true;
    if (active === false || String(active).toLowerCase() === 'false') continue;

    var name = nameCol >= 0 ? String(row[nameCol] || '').trim() : '';
    if (!name) continue;

    var propId = idCol >= 0 ? String(row[idCol] || '').trim() : '';
    var prefix = prefixCol >= 0 ? String(row[prefixCol] || '').trim().toUpperCase() : '';
    var shortName = '';
    if (shortCol >= 0) {
      shortName = String(row[shortCol] || '').trim();
    }
    if (!shortName && prefix) {
      shortName = prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase();
    }
    if (!shortName) shortName = name;
    var unitCount = 0;
    var occupiedCount = 0;
    if (propId && unitsByPropId[propId] !== undefined) {
      unitCount = unitsByPropId[propId];
      occupiedCount = occupiedByPropId[propId] || 0;
    } else if (unitsByProp[name]) {
      unitCount = Object.keys(unitsByProp[name]).length;
      occupiedCount = unitCount;
    }

    result.push({
      name: name,
      shortName: shortName || name,
      ticketPrefix: prefix || undefined,
      open: openByProp[name] || 0,
      urgent: urgentByProp[name] || 0,
      units: unitCount,
      occupied: occupiedCount,
      avgResolution: '—',
      lastActivity: '—',
      address: addrCol >= 0 ? String(row[addrCol] || '').trim() : ''
    });
  }

  try {
    cache.put(CACHE_KEY_PROPERTIES, JSON.stringify(result), CACHE_TTL);
  } catch (e) {}
  console.log('[portal:properties] built ' + result.length + ' rows, ' + (new Date().getTime() - t0) + 'ms');
  return result;
}
