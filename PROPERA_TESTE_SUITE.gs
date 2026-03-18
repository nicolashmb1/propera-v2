// ============================================================
// TSv2 — PROPERA AUTOMATED TEST SUITE (CLEAN / DETERMINISTIC)
// ============================================================
// Sheets
const TS2_WORKITEMS_SHEET  = 'Sheet1';
const TS2_DIRECTORY_SHEET  = 'Directory';
const TS2_CTX_SHEET        = 'ConversationContext';
const TS2_SESSIONS_SHEET   = 'Sessions';
const TS2_LOG_SHEET        = 'DevSmsLog_SIM';
const TS2_SCENARIOS_SHEET  = 'TestScenarios';
const TS2_RESULTS_SHEET    = 'TestResults';
const TS2_INBOX_SHEET      = 'AgentInbox';

// ScenarioSheet columns (1-based)
const TS2_SC_RUNFLAG   = 1;
const TS2_SC_ID        = 2;
const TS2_SC_DESC      = 3;
const TS2_SC_PHONE     = 4;
const TS2_SC_MESSAGES  = 5;
const TS2_SC_DELAYMS   = 6;
const TS2_SC_NOTES     = 7;
const TS2_SC_LASTRUNAT = 8;
const TS2_SC_STATUS    = 9;
const TS2_SC_RUNID     = 10;

// Log columns (DevLogSms_SIM) (1-based)
const TS2_LOG_COL_TS     = 1;
const TS2_LOG_COL_PHONE  = 2;
const TS2_LOG_COL_MSG    = 3;
const TS2_LOG_COL_STATUS = 4;
const TS2_LOG_COL_EXTRA  = 5;

// Directory / CTX / Sessions / WI columns (adjust if needed)
const TS2_DIR_COL_PHONE = 1;
const TS2_CTX_COL_PHONE = 1;
const TS2_SESS_COL_PHONE = 1;
const TS2_WI_COL_PHONE   = 2;
const TS2_WI_COL_STATUS  = 17;

// ============================================================
// Lock wrapper: use your withWriteLock_ if present, else ScriptLock
// ============================================================
function TSv2_withLock_(label, fn) {
  if (typeof withWriteLock_ === 'function') {
    return withWriteLock_(label, fn);
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { try { lock.releaseLock(); } catch (_) {} }
}

// ============================================================
// Run ID
// ============================================================
function TSv2_getNextRunId_() {
  const props = PropertiesService.getScriptProperties();
  const current = parseInt(props.getProperty('TS2_RUN_COUNTER') || '0', 10);
  const next = current + 1;
  props.setProperty('TS2_RUN_COUNTER', String(next));
  return 'RUN_' + String(next).padStart(4, '0');
}
function TSv2_getLatestRunIdFromResults_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(TS2_RESULTS_SHEET);
  if (!sh) return '';
  const data = sh.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    const runId = String(data[i][0] || '').trim();
    if (runId) return runId;
  }
  return '';
}

// ============================================================
// Marker writing (robust + locked)
// ============================================================
function TSv2_markerKey_(runId, scenarioId) {
  return 'runId=[' + runId + '] scenarioId=[' + scenarioId + ']';
}

function writeScenarioMarker_(phone, scenarioId, runId, markerType) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(TS2_LOG_SHEET); // 'DevLogSms_SIM'
    if (!sh) {
      Logger.log('TS_MARKER_ERR missing sheet=' + TS2_LOG_SHEET + ' ssId=' + ss.getId());
      return;
    }

    const status = String(markerType || '') + ' runId=' + runId + ' id=' + scenarioId;

    // Use your lock helper if present, else ScriptLock
    if (typeof withWriteLock_ === 'function') {
      withWriteLock_('TS_MARKER_' + markerType, function () {
        sh.appendRow([new Date(), String(phone || ''), 'SUITE_MARKER', status, '']);
        SpreadsheetApp.flush();
      });
    } else {
      const lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        sh.appendRow([new Date(), String(phone || ''), 'SUITE_MARKER', status, '']);
        SpreadsheetApp.flush();
      } finally {
        try { lock.releaseLock(); } catch (_) {}
      }
    }
  } catch (e) {
    Logger.log('TS_MARKER_ERR ' + e);
  }
}

function TSv2_writeMarker_(phone, runId, scenarioId, markerType) {
  writeScenarioMarker_(phone, scenarioId, runId, markerType);
}

// ============================================================
// Reset tenant state (locked, deterministic)
// ============================================================
function TSv2_resetTenantState_(phone) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const digits10 = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!digits10) return;

  function phoneMatch_(rowVal) {
    return String(rowVal || '').replace(/\D/g, '').slice(-10) === digits10;
  }

  function deleteMatchingRows_(sheet, colIndex) {
    const data = sheet.getDataRange().getValues();
    const toDelete = [];
    for (let i = 1; i < data.length; i++) {
      if (phoneMatch_(data[i][colIndex - 1])) toDelete.push(i + 1);
    }
    for (let i = toDelete.length - 1; i >= 0; i--) sheet.deleteRow(toDelete[i]);
    return toDelete.length;
  }

  TSv2_withLock_('TS2_RESET_TENANT', () => {
    const dir = ss.getSheetByName(TS2_DIRECTORY_SHEET);
    if (dir) deleteMatchingRows_(dir, TS2_DIR_COL_PHONE);

    const ctx = ss.getSheetByName(TS2_CTX_SHEET);
    if (ctx) deleteMatchingRows_(ctx, TS2_CTX_COL_PHONE);

    const sess = ss.getSheetByName(TS2_SESSIONS_SHEET);
    if (sess) deleteMatchingRows_(sess, TS2_SESS_COL_PHONE);

    const wi = ss.getSheetByName(TS2_WORKITEMS_SHEET);
    if (wi) {
      const wiData = wi.getDataRange().getValues();
      for (let i = 1; i < wiData.length; i++) {
        const status = String(wiData[i][TS2_WI_COL_STATUS - 1] || '').trim();
        if (phoneMatch_(wiData[i][TS2_WI_COL_PHONE - 1]) && status !== 'CLOSED' && status !== 'CANCELLED') {
          wi.getRange(i + 1, TS2_WI_COL_STATUS, 1, 1).setValue('CANCELLED');
        }
      }
    }

    SpreadsheetApp.flush();
  });
}

// ============================================================
// Harvest logs between markers (match by Status, not Extra)
// ============================================================
function TSv2_harvestLogs_(phone, runId, scenarioId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(TS2_LOG_SHEET);
  if (!logSheet) return [];

  const data = logSheet.getDataRange().getValues();
  const digits10 = String(phone || '').replace(/\D/g, '').slice(-10);

  function isMyStart_(rowMsg, rowStatus) {
    const s = String(rowStatus || '');
    return String(rowMsg || '').trim() === 'SUITE_MARKER'
      && s.includes('SCENARIO_START')
      && s.includes('runId=' + runId)
      && s.includes('id=' + scenarioId);
  }

  function isNextStartSameRun_(rowMsg, rowStatus) {
    const s = String(rowStatus || '');
    return String(rowMsg || '').trim() === 'SUITE_MARKER'
      && s.includes('SCENARIO_START')
      && s.includes('runId=' + runId);
  }

  function isSuiteEnd_(rowMsg, rowStatus) {
    const s = String(rowStatus || '');
    return String(rowMsg || '').trim() === 'SUITE_MARKER'
      && s.includes('SUITE_END')
      && s.includes('runId=' + runId);
  }

  // Find start index
  let startIdx = -1;
  for (let i = 1; i < data.length; i++) {
    const rowMsg = data[i][TS2_LOG_COL_MSG - 1];
    const rowStatus = data[i][TS2_LOG_COL_STATUS - 1];
    if (isMyStart_(rowMsg, rowStatus)) { startIdx = i; break; }
  }
  if (startIdx < 0) return [];

  // End at next scenario start in same run OR suite end OR end of sheet
  let endIdx = data.length;
  for (let i = startIdx + 1; i < data.length; i++) {
    const rowMsg = data[i][TS2_LOG_COL_MSG - 1];
    const rowStatus = data[i][TS2_LOG_COL_STATUS - 1];
    if (isSuiteEnd_(rowMsg, rowStatus) || isNextStartSameRun_(rowMsg, rowStatus)) {
      endIdx = i;
      break;
    }
  }

  const results = [];
  for (let i = startIdx + 1; i < endIdx; i++) {
    const rawTs    = data[i][TS2_LOG_COL_TS - 1];
    const rowPhone = String(data[i][TS2_LOG_COL_PHONE - 1] || '');
    const rowMsg   = String(data[i][TS2_LOG_COL_MSG - 1] || '');
    const rowStat  = String(data[i][TS2_LOG_COL_STATUS - 1] || '');
    const rowExtra = String(data[i][TS2_LOG_COL_EXTRA - 1] || '');

    const rowDigits = rowPhone.replace(/\D/g, '').slice(-10);
    if (digits10 && rowDigits && rowDigits !== digits10) continue;

    const ts = (rawTs instanceof Date) ? rawTs : new Date(rawTs);
    results.push({
      ts: isNaN(ts.getTime()) ? String(rawTs) : ts.toISOString(),
      phone: rowPhone,
      msg: rowMsg,
      status: rowStat,
      extra: rowExtra,
      raw: rawTs + '\t' + rowPhone + '\t' + rowMsg + '\t' + rowStat + '\t' + rowExtra
    });
  }

  return results;
}

// ============================================================
// Evaluate scenario (minimal universal checks)
// ============================================================
function TSv2_evaluate_(scenarioId, logs) {
  const passed = [];
  const failed = [];
  const issues = [];

  function logContains(str) {
    return logs.some(l => (l.msg + ' ' + l.status + ' ' + l.extra).includes(str));
  }

  if (logs.length > 0) passed.push('HARVEST ok (' + logs.length + ' rows)');
  else {
    failed.push('HARVEST_EMPTY');
    issues.push('No logs captured between markers');
    return { result: 'FAIL', passed, failed, issues };
  }

  if (logContains('OUT_SMS')) passed.push('OUT_SMS present');
  else { failed.push('OUT_SMS missing'); issues.push('No reply sent'); }

  if (logContains('ROUTER_LANE')) passed.push('ROUTER_LANE present');
  else failed.push('ROUTER_LANE missing');

  if (logContains('STATE_RESOLVED')) passed.push('STATE_RESOLVED present');
  else failed.push('STATE_RESOLVED missing');

  if (logContains('Exception') || logContains('TypeError')) {
    failed.push('Exception detected');
    issues.push('Exception in logs');
  } else {
    passed.push('No exceptions');
  }

  let result = 'PASS';
  if (failed.length) result = (failed.length <= 2 && passed.length) ? 'WARN' : 'FAIL';
  return { result, passed, failed, issues };
}

// ============================================================
// Build TestResults (writes HARVEST_EMPTY sentinel if needed)
// ============================================================
function TSv2_buildReport_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const scenSheet = ss.getSheetByName(TS2_SCENARIOS_SHEET);
  if (!scenSheet) return;

  let resultsSheet = ss.getSheetByName(TS2_RESULTS_SHEET);
  if (!resultsSheet) resultsSheet = ss.insertSheet(TS2_RESULTS_SHEET);
  resultsSheet.clearContents();

  const header = [
    'RunID','ScenarioID','Description','Phone','RunAt','Result',
    'Checks Passed','Checks Failed','Issues Found','Raw Log'
  ];
  resultsSheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');

  const scenData = scenSheet.getDataRange().getValues();
  let outRow = 2;

  for (let i = 1; i < scenData.length; i++) {
    const runFlag = scenData[i][TS2_SC_RUNFLAG - 1];
    const scenarioId = String(scenData[i][TS2_SC_ID - 1] || '').trim();
    const desc = String(scenData[i][TS2_SC_DESC - 1] || '').trim();
    const phone = String(scenData[i][TS2_SC_PHONE - 1] || '').trim();
    const runAt = scenData[i][TS2_SC_LASTRUNAT - 1];
    const status = String(scenData[i][TS2_SC_STATUS - 1] || '').trim();
    const runId = String(scenData[i][TS2_SC_RUNID - 1] || '').trim();

    if (!scenarioId || !runId) continue;
    if (status !== 'DONE') continue;

    const logs = TSv2_harvestLogs_(phone, runId, scenarioId);
    const evalr = TSv2_evaluate_(scenarioId, logs);

    const logText = logs.length
      ? logs.map(l => l.raw).join('\n')
      : ('(HARVEST_EMPTY) runId=[' + runId + '] scenarioId=[' + scenarioId + '] phone=[' + phone + ']');

    resultsSheet.getRange(outRow, 1, 1, 10).setValues([[
      runId, scenarioId, desc, phone,
      (runAt instanceof Date ? runAt.toISOString() : String(runAt || '')),
      evalr.result,
      evalr.passed.join(', '),
      evalr.failed.join(', '),
      evalr.issues.join(' | '),
      logText
    ]]);

    outRow++;
  }

  resultsSheet.autoResizeColumns(1, 9);
}

// ============================================================
// Build AgentInbox for latest run (or specific runId)
// ============================================================
function TSv2_buildAgentInbox(runIdOverride) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const resultsSheet = ss.getSheetByName(TS2_RESULTS_SHEET);
  if (!resultsSheet) {
    SpreadsheetApp.getUi().alert('TestResults sheet not found. Run TSv2_run first.');
    return;
  }

  const targetRunId = runIdOverride || TSv2_getLatestRunIdFromResults_();
  if (!targetRunId) {
    SpreadsheetApp.getUi().alert('No runs found in TestResults.');
    return;
  }

  let inbox = ss.getSheetByName(TS2_INBOX_SHEET);
  if (!inbox) inbox = ss.insertSheet(TS2_INBOX_SHEET);
  inbox.clearContents();

  const data = resultsSheet.getDataRange().getValues();

  const lines = [];
  lines.push('# PROPERA TEST RUN — AGENT INBOX');
  lines.push('# RunID: ' + targetRunId);
  lines.push('# Generated: ' + new Date().toISOString());
  lines.push('');
  lines.push('---');
  lines.push('');

  const summary = [];
  const failRows = [];

  for (let i = 1; i < data.length; i++) {
    const runId   = String(data[i][0] || '').trim();
    if (runId !== targetRunId) continue;

    const scenId  = String(data[i][1] || '').trim();
    const desc    = String(data[i][2] || '').trim();
    const phone   = String(data[i][3] || '').trim();
    const runAt   = String(data[i][4] || '').trim();
    const result  = String(data[i][5] || '').trim();
    const passed  = String(data[i][6] || '').trim();
    const failed  = String(data[i][7] || '').trim();
    const issues  = String(data[i][8] || '').trim();
    const rawLog  = String(data[i][9] || '');

    summary.push(result + '\t' + scenId + '\t' + desc);

    if (result === 'FAIL' || result === 'WARN') {
      failRows.push({ scenId, desc, phone, runAt, result, passed, failed, issues, rawLog });
    }
  }

  lines.push('## SUITE SUMMARY');
  lines.push('');
  summary.forEach(s => lines.push(s));
  lines.push('');
  lines.push('Total flagged: ' + failRows.length);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## FAILING SCENARIOS — FULL LOGS');
  lines.push('');

  failRows.forEach(row => {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('SCENARIO: ' + row.scenId + ' — ' + row.desc);
    lines.push('Phone: ' + row.phone);
    lines.push('RunAt: ' + row.runAt);
    lines.push('Result: ' + row.result);
    lines.push('');
    lines.push('Passed: ' + row.passed);
    lines.push('Failed: ' + row.failed);
    lines.push('Issues: ' + row.issues);
    lines.push('');
    lines.push('RAW LOG:');
    lines.push('────────────────────────────────────────');
    if (row.rawLog) row.rawLog.split('\n').forEach(ll => { if (ll.trim()) lines.push(ll); });
    else lines.push('(no harvested logs)');
    lines.push('');
  });

  const output = lines.map(l => [l]);
  inbox.getRange(1, 1, output.length, 1).setValues(output);
  inbox.setColumnWidth(1, 900);
  ss.setActiveSheet(inbox);
}

// ============================================================
// Runner
// ============================================================
function TSv2_run() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const scenSheet = ss.getSheetByName(TS2_SCENARIOS_SHEET);
  if (!scenSheet) {
    SpreadsheetApp.getUi().alert('TestScenarios sheet not found. Run TSv2_createScenarioSheet first.');
    return;
  }

  const runId = TSv2_getNextRunId_();
  const data = scenSheet.getDataRange().getValues();

  // suite start marker (blank phone)
  TSv2_writeMarker_('', runId, 'SUITE', 'SUITE_START');

  let ran = 0, errors = 0;

  for (let i = 1; i < data.length; i++) {
    const runFlag = data[i][TS2_SC_RUNFLAG - 1];
    const scenarioId = String(data[i][TS2_SC_ID - 1] || '').trim();
    const phone = String(data[i][TS2_SC_PHONE - 1] || '').trim();
    const messagesRaw = String(data[i][TS2_SC_MESSAGES - 1] || '').trim();
    const delayMs = parseInt(data[i][TS2_SC_DELAYMS - 1], 10) || 1000;

    if (!runFlag || String(runFlag).toUpperCase() === 'FALSE') continue;
    if (!scenarioId || !phone || !messagesRaw) continue;

    const rowNum = i + 1;

    // mark running
    scenSheet.getRange(rowNum, TS2_SC_LASTRUNAT).setValue(new Date().toISOString());
    scenSheet.getRange(rowNum, TS2_SC_STATUS).setValue('RUNNING');
    scenSheet.getRange(rowNum, TS2_SC_RUNID).setValue(runId);
    SpreadsheetApp.flush();

    try {
      // reset
      TSv2_resetTenantState_(phone);
      Utilities.sleep(500);

      // marker start
      TSv2_writeMarker_(phone, runId, scenarioId, 'SCENARIO_START');

      // fire messages
      const messages = messagesRaw.split('|').map(s => s.trim()).filter(Boolean);

      for (let m = 0; m < messages.length; m++) {
        const msg = messages[m];
        // NOTE: uses your real EMU entrypoint
        emulateTwilioInbound_(phone, msg, 'TENANT');
        if (m < messages.length - 1) Utilities.sleep(delayMs);
      }

      // drain before end marker (critical!)
      Utilities.sleep(1500);
      SpreadsheetApp.flush();

      // marker end
      TSv2_writeMarker_(phone, runId, scenarioId, 'SCENARIO_END');

      // done
      scenSheet.getRange(rowNum, TS2_SC_STATUS).setValue('DONE');
      SpreadsheetApp.flush();

      ran++;
    } catch (e) {
      errors++;
      try { TSv2_writeMarker_(phone, runId, scenarioId, 'SCENARIO_ERROR'); } catch (_) {}
      scenSheet.getRange(rowNum, TS2_SC_STATUS).setValue('ERROR: ' + (e && e.message ? e.message : String(e)));
      SpreadsheetApp.flush();
    }

    Utilities.sleep(300);
  }

  TSv2_writeMarker_('', runId, 'SUITE', 'SUITE_END');

  TSv2_buildReport_();
  TSv2_buildAgentInbox(runId);

  SpreadsheetApp.getUi().alert('TSv2 complete: ' + runId + '\nRan: ' + ran + '\nErrors: ' + errors);
}

// ============================================================
// Scenario sheet creator (uses your SIM phones)
// ============================================================
function TSv2_createScenarioSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TS2_SCENARIOS_SHEET);
  if (sheet) {
    const ui = SpreadsheetApp.getUi();
    const resp = ui.alert('TestScenarios already exists. Recreate?', ui.ButtonSet.YES_NO);
    if (resp !== ui.Button.YES) return;
    ss.deleteSheet(sheet);
  }

  sheet = ss.insertSheet(TS2_SCENARIOS_SHEET);

  const headers = [
    'RunFlag','ScenarioID','Description','Phone',
    'Messages (pipe-separated)','DelayMs','Precondition/Notes',
    'LastRunAt','LastRunStatus','LastRunID'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');

  const seeds = [
    [true,'TC-001','Bare number followup should stay MAINT lane',
      '+19085550101','service request apt 304 PENN. my washer is not draining|600',1000,'', '', '', ''],
    [true,'TC-002','Pending override should update unit without crash',
      '+19085550102','my sink is leaking|apt 304|actually unit 412',1000,'', '', '', ''],
    [true,'TC-003','Leasing intent suppressed during active maintenance',
      '+19085550103','apt 304 PENN sink is broken|I need a 2 bedroom',1000,'', '', '', ''],
    [true,'TC-010','Misspelled unit parse: apat 320',
      '+19085550104','apat 320 PENN my heat is out',1000,'', '', '', ''],
    [true,'TC-020','Happy path: ticket + schedule confirm',
      '+19085550105','service request apt 304 PENN. my washer is not draining|penn|tomorrow 3-5pm',1200,'', '', '', ''],
  ];

  sheet.getRange(2, 1, seeds.length, headers.length).setValues(seeds);
  sheet.autoResizeColumns(1, headers.length);
  sheet.getRange(2, 1, seeds.length, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build()
  );

  SpreadsheetApp.getUi().alert('TSv2 TestScenarios created.\nRun TSv2_run().');
}

// ============================================================
// Menu
// ============================================================
function TSv2_onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🧪 TSv2 Suite')
    .addItem('1) Create Scenarios Sheet', 'TSv2_createScenarioSheet')
    .addSeparator()
    .addItem('2) Run Suite', 'TSv2_run')
    .addItem('3) Build Report Only', 'TSv2_buildReport_')
    .addItem('4) Build AgentInbox (latest)', 'TSv2_buildAgentInbox')
    .addToUi();
}