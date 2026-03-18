# Resident Enrichment — Exact Code Sections

All line numbers refer to **PROPERA MAIN.gs**. These sections support the implementation path: pass tenantNameHint into finalize, run post-finalize resident lookup, patch ticket/WI when exactly one confident match.

---

## 1. finalizeDraftAndCreateTicket_() — full function

**Location:** 2665–3187

- **processTicket_** is called at **2864–2893** (payload includes `from`, `tenantPhone`, `propertyName`, `propertyCode`, `unitFromText`, `messageRaw`, `createdByManager`, `inboundKey`, etc.).
- **workItemCreate_** is called at **3061–3080** with `phoneE164: phone`, `propertyId: propCode`, `unitId: unit`, `ticketRow: loggedRow`, `metadataJson: JSON.stringify({ source, inboundKey })`.
- **maybePolicyRun_** runs at **3131–3136** (`maybePolicyRun_("WORKITEM_CREATED", { phoneE164: phone, lang: "en" }, wiForPolicy, propCode)`).
- There is **no** single write-lock scope that wraps “post-create updates” in general. Directory is updated under `dalWithLock_("FINALIZE_DIR_SET_PTR", ...)` (2819–2842). Ticket schedule/PREF_WINDOW is updated under `withWriteLock_("MULTI_SCHEDULE_APPLY", ...)` or `withWriteLock_("DRAFT_SCHEDULE_APPLY", ...)` (2987–3018). Sheet1 assignment is written at 3154–3168 **without** a lock wrapper (direct `sheet.getRange(loggedRow, COL.ASSIGNED_TO, ...).setValues`). So a **new** lock (e.g. `withWriteLock_("STAFFCAP_TENANT_ENRICH", ...)`) around ticket PHONE + WI phoneE164/metadata patch would be appropriate.
- **Local variables available** after ticket + WI create (and after policy run) for enrichment:
  - `propCode`, `propName` — from 2680–2681 and Directory
  - `unit` — from 2682–2684 and Directory/session
  - `loggedRow` — ticket row (2896–2898)
  - `ticketId` — 2902
  - `createdWi` — 3062
  - `phone` — argument (draft phone e.g. "SCAP:D29")
  - `opts` — argument; **opts does not currently include tenantNameHint** (see section 8)
  - `sheet`, `dir`, `dirRow` — arguments
  - `ticket` — return from processTicket_
  - `asn`, `wiCached`, `pol` — assignment and policy result

**Full function (2665–3187):**

```javascript
  function finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, from, opts) {
    opts = opts || {};
    var locationTextHint = String(opts.locationText || "").trim();

    var existingPendingRow = dalGetPendingRow_(dir, dirRow);
    var existingStage = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();

    if (existingPendingRow >= 2 && !opts.createdByManager) {
      try { logDevSms_(phone, "", "FINALIZE_DRAFT_BLOCKED row=[" + existingPendingRow + "] stage=[" + existingStage + "]"); } catch (_) {}
      try { logInvariantFail_(phone, "", "NO_NEW_TICKET_WHEN_PENDINGROW", "row=" + existingPendingRow + " stage=" + existingStage); } catch (_) {}
      return { ok: false, reason: "ACTIVE_TICKET_EXISTS" };
    }

    var propCol = dalGetPendingProperty_(dir, dirRow);
    var propCode = propCol.code;
    var propName = propCol.name;
    var pendingUnit = dalGetPendingUnit_(dir, dirRow);
    var canonUnit   = dalGetUnit_(dir, dirRow);
    var unit        = String((pendingUnit || canonUnit) || "").trim();
    var issue    = dalGetPendingIssue_(dir, dirRow);
    // ... issue/buf/session reads, multi-issue defer logic ...
    if (locType === "COMMON_AREA") {
      unit = "";
    }

    const ticket = processTicket_(sheet, sp, { OPENAI_API_KEY: ..., TWILIO_SID: ..., ... }, {
      from: phone,
      tenantPhone: phone,
      propertyName: propName,
      propertyCode: propCode,
      unitFromText: unit,
      messageRaw: issueForTicket,
      createdByManager: !!(opts.createdByManager),
      inboundKey: opts.inboundKey || ("DRAFT:" + phone + "|TS:" + Date.now()),
      parsedIssue: parsedIssueForGate,
      locationType: locType,
      firstMediaUrl: firstMediaUrl,
      attachmentMediaFacts: attachmentMediaFacts
    });

    var rawRow = ticket != null ? (ticket.rowIndex != null ? ticket.rowIndex : ticket.row) : undefined;
    var loggedRow = parseInt(String(rawRow || "").trim(), 10) || 0;
    if (!loggedRow || loggedRow < 2) {
      try { logDevSms_(phone, issue, "FINALIZE_DRAFT_ROW_ERR " + JSON.stringify(ticket || {})); } catch (_) {}
      return { ok: false, reason: "ROW_ERR" };
    }

    const ticketId = String(ticket && ticket.ticketId ? ticket.ticketId : "").trim();
    // ... nextStage, emergency, dalWithLock_ FINALIZE_DIR_SET_PTR, session close, enqueueAiEnrichment_, schedule apply ...

    // ── Resolve assignment ──
    var asn = null;
    var _srPatch = null;
    // ... srBuildWorkItemOwnerPatch_ / resolveWorkItemAssignment_ ...

    var createdWi = "";
    try {
      createdWi = workItemCreate_({
        type: "MAINT",
        status: "OPEN",
        state: "STAFF_TRIAGE",
        substate: nextStage,
        phoneE164: phone,
        propertyId: propCode,
        unitId: unit,
        ticketRow: loggedRow,
        metadataJson: JSON.stringify({
          source: opts.createdByManager ? "MGR_DRAFT" : "DRAFT",
          inboundKey: String(opts.inboundKey || "")
        }),
        ownerType: (asn && asn.ownerType) || "",
        ownerId: (asn && asn.ownerId) || "",
        assignedByPolicy: (asn && asn.assignedByPolicy) || "",
        assignedAt: (asn && asn.assignedAt) || ""
      });
    } catch (err) {
      try { logDevSms_(phone, issue, "FINALIZE_WI_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
    }

    var wiCached = null;
    try { wiCached = (typeof workItemGetById_ === "function") ? workItemGetById_(createdWi) : null; } catch (_) {}

    if (isEmergencyTicket && createdWi && typeof workItemUpdate_ === "function") {
      try { workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "EMERGENCY" }); } catch (_) {}
    }

    var pol = { ackOwned: false, ackSent: false, ruleId: "" };
    try {
      if (createdWi && typeof maybePolicyRun_ === "function") {
        var wiForPolicy = wiCached || { workItemId: createdWi, state: "STAFF_TRIAGE", ... };
        var policyResult = maybePolicyRun_("WORKITEM_CREATED", { phoneE164: phone, lang: "en" }, wiForPolicy, propCode);
        if (policyResult && typeof policyResult === "object") {
          pol.ackOwned = !!policyResult.ackOwned;
          pol.ackSent = !!policyResult.ackSent;
          pol.ruleId = String(policyResult.ruleId || "");
        }
      }
    } catch (policyErr) { ... }

    // ... emergency state re-enforce, Sheet1 assignment write (loggedRow, COL.ASSIGNED_*), ctxUpsert_ ...

    return { ok: true, loggedRow, ticketId, createdWi, nextStage, locationType: locType, ticket, ackOwnedByPolicy: pol.ackOwned, policyRuleId: pol.ruleId, ownerType: (asn && asn.ownerType) ? String(asn.ownerType) : "", ownerId: (asn && asn.ownerId) ? String(asn.ownerId) : "" };
  }
```

---

## 2. processTicket_() — full function

**Location:** 7918–8303

- Ticket row is built as a single array `newRow` and written once with `sheet.getRange(rowIndex, 1, 1, MAX_COL).setValues([newRow])` (8022–8132). Columns are set via **setRowCol_(rowArr, k, val)** which uses **colNum_(k)** (COL[k]). There is **no** separate “update ticket phone later” helper inside processTicket_; it only writes at create.
- **COL.RESIDENT_ID** is defined (COL.RESIDENT_ID: 40) but **not** set anywhere in processTicket_; the create path does not touch RESIDENT_ID.
- **isStaffcap** (8028) forces **phoneVal = ""** for ticket PHONE when `inboundKey` starts with `STAFFCAP:`. A **later** update that sets COL.PHONE to a resolved E.164 would not conflict with that logic; processTicket_ only runs at create. No code in processTicket_ re-reads or overwrites PHONE after create. The only later writes to the same row are in the **TICKET_POSTCLASSIFY** lock (8122–8136: CAT, EMER, URG, etc.) and escalation (ESCALATED). So patching PHONE (and optionally RESIDENT_ID) after create is safe as long as it’s done via a locked sheet write.

**Relevant create block (8022–8035):**

```javascript
      const isStaffcap = String(inboundKey || "").startsWith("STAFFCAP:");
      const isRealE164 = /^\+1\d{10}$/.test(String(requesterPhone || "").trim());
      const phoneVal = isStaffcap ? "" : (isMgr ? (isRealE164 ? requesterPhone : "") : requesterPhone);
      setRowCol_(newRow, "TS", now);
      setRowCol_(newRow, "PHONE", phoneVal);
      setRowCol_(newRow, "PROPERTY", propertyName || "");
      setRowCol_(newRow, "UNIT", unitFromText || "");
      setRowCol_(newRow, "MSG", messageRaw || "");
```

**Post-classify write (8122–8136)** — same row, different columns; no PHONE:

```javascript
    withWriteLock_("TICKET_POSTCLASSIFY", () => {
      const fullRow = sheet.getRange(rowIndex, 1, 1, MAX_COL).getValues()[0];
      function setCol_(k, val) {
        const c = colNum_(k);
        if (c && c <= fullRow.length) fullRow[c - 1] = val;
      }
      setCol_("CAT", classification.category || "");
      setCol_("EMER", classification.emergency ? "Yes" : "No");
      setCol_("EMER_TYPE", classification.emergencyType || "");
      setCol_("URG", classification.urgency || "Normal");
      setCol_("URG_REASON", classification.urgencyReason || "");
      setCol_("CONF", ...);
      setCol_("NEXT_Q", ...);
      setCol_("DUE_BY", dueBy);
      setCol_("LAST_UPDATE", now);
      setCol_("REPLY_SENT", "No");
      sheet.getRange(rowIndex, 1, 1, MAX_COL).setValues([fullRow]);
    });
```

So: **safest way to patch ticket PHONE (and optionally RESIDENT_ID) after finalize** is to use the same pattern: under a lock, `sheet.getRange(loggedRow, 1, 1, MAX_COL).getValues()[0]`, then set `fullRow[COL.PHONE - 1] = resolvedPhone`, optionally `fullRow[COL.RESIDENT_ID - 1] = residentId`, then `sheet.getRange(loggedRow, 1, 1, MAX_COL).setValues([fullRow])`. There is no existing DAL like `updateTicketPhone_(sheet, row, phone)`; you can add a small helper or inline this in finalize.

---

## 3. workItemCreate_() and workItemUpdate_()

**workItemCreate_** (3986–4017):

```javascript
  function workItemCreate_(obj) {
    ensureWorkBackbone_();
    var sh = getActiveSheetByNameCached_(WORKITEMS_SHEET);
    var id = obj.workItemId || ("WI_" + Utilities.getUuid().slice(0, 8));
    var now = new Date();

    var row = [
      id,
      String(obj.type || "MAINT").trim(),
      String(obj.status || "OPEN").trim(),
      String(obj.state || "INTAKE").trim(),
      String(obj.substate || "").trim(),
      String(obj.phoneE164 || "").trim(),
      String(obj.propertyId || "").trim(),
      String(obj.unitId || "").trim(),
      obj.ticketRow ? Number(obj.ticketRow) : "",
      String(obj.metadataJson || "").trim(),
      now,
      now,
      String(obj.ownerType || "").trim(),
      String(obj.ownerId || "").trim(),
      String(obj.assignedByPolicy || "").trim(),
      (obj.assignedAt instanceof Date) ? obj.assignedAt : (obj.assignedAt ? new Date(obj.assignedAt) : "")
    ];

    withWriteLock_("WORKITEM_CREATE", function () {
      sh.appendRow(row);
    });
    return id;
  }
```

**workItemUpdate_** (4053–4071):

```javascript
  function workItemUpdate_(workItemId, patch) {
    ensureWorkBackbone_();
    const sh = getActiveSheetByNameCached_(WORKITEMS_SHEET);
    const r = findRowByValue_(sh, "WorkItemId", workItemId);
    if (!r) return false;

    withWriteLock_("WORKITEM_UPDATE", () => {
      if (patch.status !== undefined) sh.getRange(r, col_(sh, "Status")).setValue(String(patch.status));
      if (patch.state !== undefined) sh.getRange(r, col_(sh, "State")).setValue(String(patch.state));
      if (patch.substate !== undefined) sh.getRange(r, col_(sh, "Substate")).setValue(String(patch.substate));
      if (patch.propertyId !== undefined) sh.getRange(r, col_(sh, "PropertyId")).setValue(String(patch.propertyId));
      if (patch.unitId !== undefined) sh.getRange(r, col_(sh, "UnitId")).setValue(String(patch.unitId));
      if (patch.ticketRow !== undefined) sh.getRange(r, col_(sh, "TicketRow")).setValue(patch.ticketRow ? Number(patch.ticketRow) : "");
      if (patch.metadataJson !== undefined) sh.getRange(r, col_(sh, "MetadataJson")).setValue(String(patch.metadataJson || ""));
      sh.getRange(r, col_(sh, "UpdatedAt")).setValue(new Date());
    });

    return true;
  }
```

**workItemUpdate_ does not currently support `phoneE164`.** To patch PhoneE164 after resident lookup you can either:
- **Extend workItemUpdate_** with `if (patch.phoneE164 !== undefined) sh.getRange(r, col_(sh, "PhoneE164")).setValue(String(patch.phoneE164 || ""));`, or
- Do one-off direct sheet write under lock using `col_(sh, "PhoneE164")` and `findRowByValue_(sh, "WorkItemId", workItemId)`.

No other WorkItem DAL (e.g. setWorkItemField_) exists; **workItemUpdate_** is the only updater. Metadata is patched by passing a full **metadataJson** string (merge-then-stringify in caller).

---

## 4. findTenantCandidates_() — full implementation

**Location:** 11973–12040

```javascript
  function normalizeName_(s) {
    return String(s || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  }

  function scoreNameMatch_(queryName, rowName) {
    const q = normalizeName_(queryName);
    const r = normalizeName_(rowName);
    if (!q || !r) return 0;
    if (q === r) return 100;
    if (r.startsWith(q) || q.startsWith(r)) return 85;   // john vs johnathan
    if (r.includes(q) || q.includes(r)) return 70;
    return 0;
  }

  // returns [{phone,name,score}]
  function findTenantCandidates_(propertyName, unit, queryName) {
    const sh = ensureTenantsSheet_();

    const u = normalizeUnit_(String(unit || "").trim());
    if (!u) return [];

    const prop = getPropertyByNameOrKeyword_(String(propertyName || "").trim());
    if (!prop) return [];

    const lastRow = sh.getLastRow();
    if (lastRow < 2) return [];

    // Tenants columns: 1 Property, 2 Unit, 3 Phone, 4 Name, 5 UpdateAt, 6 Notes, 7 Active
    const data = sh.getRange(2, 1, lastRow - 1, 7).getValues();

    const qn = String(queryName || "").trim();
    const qnLower = qn.toLowerCase();

    const found = [];

    for (let i = 0; i < data.length; i++) {
      const rpName = String(data[i][0] || "").trim();
      const ru = normalizeUnit_(String(data[i][1] || "").trim());

      const d10 = String(normalizePhoneDigits_(data[i][2] || "") || "").slice(-10);
      if (!d10) continue;

      const rname = String(data[i][3] || "").trim();

      // Active can be Yes/TRUE/1/blank
      const activeRaw = data[i][6];
      const a = String(activeRaw || "").trim().toLowerCase();
      const isActive =
        (activeRaw === true) ||
        (a === "" || a === "yes" || a === "true" || a === "y" || a === "1");
      if (!isActive) continue;

      if (ru !== u) continue;

      const rp = getPropertyByNameOrKeyword_(rpName);
      if (!rp || rp.code !== prop.code) continue;

      // Name scoring: if no queryName provided, accept all with neutral score
      const score = qn ? scoreNameMatch_(qnLower, rname) : 100;
      if (qn && score <= 0) continue;

      found.push({ phone: "+1" + d10, name: rname, score: score });
    }

    const best = {};
    found.forEach(x => {
      if (!best[x.phone] || x.score > best[x.phone].score) best[x.phone] = x;
    });

    return Object.keys(best)
      .map(k => best[k])
      .sort((a, b) => (b.score || 0) - (a.score || 0));
  }
```

- **Property match:** By canonical **property code**. `getPropertyByNameOrKeyword_(propertyName)` and `getPropertyByNameOrKeyword_(rpName)`; row is included only if `rp.code === prop.code`.
- **Unit match:** `normalizeUnit_` on both; row must satisfy `ru === u`.
- **queryName:** Scored with **scoreNameMatch_(queryName, rowName)** (exact 100, prefix 85, includes 70, else 0). If `queryName` is provided and score is 0, row is skipped. If no queryName, all matching property+unit+active get score 100.
- **Active:** Hand-rolled: `(activeRaw === true) || (a === "" || a === "yes" || a === "true" || a === "y" || a === "1")`. **Blank is treated as active** here (unlike lookupTenantByPhoneDigits_, which treats blank as inactive).
- **Exactly one confident match:** Not enforced inside findTenantCandidates_; caller should use `candidates.length === 1` and optionally require `candidates[0].score >= 70` (or 85) for “confident.”

---

## 5. ensureTenantsSheet_() and upsertTenant_()

**ensureTenantsSheet_** (11812–11830):

```javascript
  function ensureTenantsSheet_() {
    const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    let sh = ss.getSheetByName(TENANTS_SHEET_NAME);

    if (!sh) {
      sh = ss.insertSheet(TENANTS_SHEET_NAME);
      sh.appendRow([
        "Property",
        "Unit",
        "Phone",
        "Name",
        "UpdatedAt",
        "Notes",
        "Active"
      ]);
    }

    return sh;
  }
```

**upsertTenant_** (12047–12077):

```javascript
  function upsertTenant_(propertyName, unit, phone, name) {
    const sh = ensureTenantsSheet_();
    const p = String(propertyName || "").trim();
    const u = String(unit || "").trim().toUpperCase();
    const ph = normalizePhone_(phone || "");
    const nm = String(name || "").trim();

    if (!p || !u || !ph) return;

    const lastRow = sh.getLastRow();
    if (lastRow < 2) {
      sh.appendRow([p, u, ph, nm, new Date(), "", "Yes"]);
      return;
    }

    const data = sh.getRange(2, 1, lastRow - 1, 7).getValues();
    for (let i = 0; i < data.length; i++) {
      const rp = String(data[i][0] || "").trim();
      const ru = String(data[i][1] || "").trim().toUpperCase();
      const rph = normalizePhone_(data[i][2] || "");
      if (rp === p && ru === u && rph === ph) {
        if (!String(data[i][3] || "").trim() && nm) sh.getRange(i + 2, 4).setValue(nm);
        sh.getRange(i + 2, 5).setValue(new Date());
        sh.getRange(i + 2, 7).setValue("Yes");
        return;
      }
    }

    sh.appendRow([p, u, ph, nm, new Date(), "", "Yes"]);
  }
```

- **Tenant sheet assumptions:** Columns 1–7: Property, Unit, Phone, Name, UpdatedAt, Notes, Active. No name normalization (e.g. trim/lowercase) beyond `String(name||"").trim()`.
- **Persisting captured/resolved name:** upsertTenant_ only sets Name when the row already exists and Name is blank. So “persist tenantNameHint back to Tenants” is safe for backfill; for new rows you pass name as fourth arg. No separate “resident ID” column is used here.

---

## 6. Helpers that update a ticket row by row/column

- **setRowCol_(rowArr, k, val)** (7974–7977) — used only when **building** the new row array inside processTicket_; it does not write to the sheet. It sets `rowArr[colNum_(k)-1] = val`.
- **colNum_(k)** (7969–7972) — returns `COL[k]` if numeric.
- There is **no** `getRowCol_` or `updateTicketRow_(sheet, row, colName, val)`. Other code that updates the ticket sheet does **direct** `sheet.getRange(row, COL.XXX).setValue(...)` (e.g. 2988–3018, 3162–3164, 3339, 3507–3540, 3582–3584).
- **Safest patch for ticket PHONE (and RESIDENT_ID) after finalize:** Under `withWriteLock_("STAFFCAP_TENANT_ENRICH", function() { ... })`, read the row with `sheet.getRange(loggedRow, 1, 1, MAX_COL).getValues()[0]`, set `fullRow[COL.PHONE - 1] = resolvedPhone`, optionally `fullRow[COL.RESIDENT_ID - 1] = residentIdOrEmpty`, then `sheet.getRange(loggedRow, 1, 1, MAX_COL).setValues([fullRow])`. Use the same sheet reference as finalize (e.g. `getLogSheet_()` or the `sheet` passed into finalize).

---

## 7. Helpers that update WorkItems by row or id

- **findRowByValue_(sheet, headerName, value)** (3913–3946) — returns 1-based row number or 0. Used for WorkItems as `findRowByValue_(sh, "WorkItemId", workItemId)`.
- **col_(sheet, headerName)** (3901–3906) — returns 1-based column index for a header; throws if missing.
- **workItemUpdate_(workItemId, patch)** — only updater; supports `status`, `state`, `substate`, `propertyId`, `unitId`, `ticketRow`, `metadataJson`. Does **not** support `phoneE164`; add it or do a one-off `sh.getRange(r, col_(sh, "PhoneE164")).setValue(resolvedPhone)` under lock.

---

## 8. Where turnFacts.meta.mediaTenantNameHint survives (staff capture)

**In the isStaffCapture block:**

- **compileTurn_** is called at 13524: `var turnFacts = compileTurn_(mergedPayloadText, draftPhone, "en", baseVars);`
- **maybeAttachMediaFactsToTurn_** is called at 13534: `if (typeof maybeAttachMediaFactsToTurn_ === "function") maybeAttachMediaFactsToTurn_(turnFacts, staffMediaFacts);` so **turnFacts.meta.mediaTenantNameHint** (and mediaTenantNameTrusted) are set there.
- **draftUpsertFromTurn_** at 13575 does **not** read or persist mediaTenantNameHint; it only writes property/unit/issue to Directory.
- **finalizeDraftAndCreateTicket_** is called at 13607–13619 with an **opts** object that does **not** include `tenantNameHint` or `mediaTenantNameHint`:

```javascript
            var result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, draftPhone, originPhoneStaff, {
              inboundKey: staffCapInboundKey,
              OPENAI_API_KEY: OPENAI_API_KEY,
              TWILIO_SID: TWILIO_SID,
              TWILIO_TOKEN: TWILIO_TOKEN,
              TWILIO_NUMBER: TWILIO_NUMBER,
              ONCALL_NUMBER: ONCALL_NUMBER,
              createdByManager: true,
              lang: "en",
              baseVars: baseVars,
              firstMediaUrl: staffMediaUrl,
              mediaType: (staffMediaFacts && staffMediaFacts.mediaType) ? String(staffMediaFacts.mediaType || "").trim() : "",
              mediaCategoryHint: (staffMediaFacts && staffMediaFacts.issueHints && staffMediaFacts.issueHints.category) ? String(staffMediaFacts.issueHints.category || "").trim() : "",
              mediaSubcategoryHint: (staffMediaFacts && staffMediaFacts.issueHints && staffMediaFacts.issueHints.subcategory) ? String(staffMediaFacts.issueHints.subcategory || "").trim() : "",
              mediaUnitHint: (staffMediaFacts && staffMediaFacts.unitHint) ? String(staffMediaFacts.unitHint || "").trim() : ""
            });
```

So **tenantNameHint is in scope** (turnFacts.meta.mediaTenantNameHint) but **not passed into finalize**. The cleanest move is to **pass it in opts**, e.g. add:

- `tenantNameHint: (turnFacts.meta && turnFacts.meta.mediaTenantNameHint) ? String(turnFacts.meta.mediaTenantNameHint).trim() : ""`
- optionally `tenantNameTrusted: !!(turnFacts.meta && turnFacts.meta.mediaTenantNameTrusted)`

Then inside finalizeDraftAndCreateTicket_, after ticket + WI create, run resident lookup using `opts.tenantNameHint` (and propName, unit) and patch when exactly one confident match.

---

## 9. MetadataJson readers / merge (Work Item)

- **Parse:** 7752 — `try { meta = wi.metadataJson ? JSON.parse(String(wi.metadataJson)) : {}; } catch (_) { meta = {}; }`
- **Merge and write back:** 7754–7795 — code appends to `meta.notes`, sets `meta.triageDecision`, `meta.ownerRole`, etc., then `workItemUpdate_(wiId, { state, substate, metadataJson: JSON.stringify(meta) })`. So there is **no** generic “mergeKeyIntoMetadata_(wiId, key, value)” helper; callers **parse**, mutate, **stringify**, then pass **metadataJson** to workItemUpdate_.
- For enrichment you can: read WI via workItemGetById_, parse metadataJson, set e.g. `meta.tenantNameHint`, `meta.tenantNameSource`, `meta.tenantLookupStatus`, then workItemUpdate_(wiId, { metadataJson: JSON.stringify(meta) }). No new sheet columns required.

---

## 10. Active (truthy) normalization for tenant matching

- There is **no** shared helper like `isActiveTenant_(activeRaw)`. Each place implements its own check:
  - **findTenantCandidates_** (12011–12016): `(activeRaw === true) || (a === "" || a === "yes" || a === "true" || a === "y" || a === "1")` — **blank treated as active**.
  - **lookupTenantByPhoneDigits_** (11200–11202): `(actives[i][0] === true) || (a === "true" || a === "yes" || a === "y" || a === "1")` — **blank not included**, so blank = inactive.
- So Active handling is **inconsistent** between the two. For “exactly one active match” you may want a single shared helper (e.g. `isTenantActive_(activeRaw)` returning true for true/"yes"/"y"/"1"/"true" and optionally blank) and use it in findTenantCandidates_ (and elsewhere) so behavior is consistent and robust.

---

## Summary

| Item | Finding |
|------|--------|
| finalizeDraftAndCreateTicket_ | processTicket_ at 2864; workItemCreate_ at 3061; maybePolicyRun_ at 3131. No single post-create lock; add one for enrichment. propCode, propName, unit, loggedRow, ticketId, createdWi, phone, opts available. |
| processTicket_ | setRowCol_ only when building new row; no “update ticket phone” helper. RESIDENT_ID not set. Later patch of PHONE/RESIDENT_ID under lock is safe. |
| workItemUpdate_ | Supports status, state, substate, propertyId, unitId, ticketRow, metadataJson. Does **not** support phoneE164; extend or do one-off write. |
| findTenantCandidates_ | Property by code; unit normalized; queryName scored (exact/prefix/includes); Active hand-rolled (blank=active). Caller must enforce “exactly one” and optional score threshold. |
| ensureTenantsSheet_ / upsertTenant_ | 7 columns; no name normalization; persisting name back is safe (upsert fills name when blank). |
| Ticket row patch | No DAL; use getRange(loggedRow, 1, 1, MAX_COL).getValues()[0], set fullRow[COL.PHONE-1], then setValues([fullRow]) under lock. |
| WI patch | workItemUpdate_ by id; add phoneE164 or one-off col_ + findRowByValue_ + setValue under lock. |
| mediaTenantNameHint | Set on turnFacts.meta in staff capture block; **not** in opts to finalize. Add opts.tenantNameHint (and optionally tenantNameTrusted). |
| MetadataJson | Parse → mutate → JSON.stringify → workItemUpdate_(id, { metadataJson }). No generic merge helper. |
| Active | No shared helper; findTenantCandidates_ treats blank as active, lookupTenantByPhoneDigits_ does not. Consider isTenantActive_() for consistency. |
