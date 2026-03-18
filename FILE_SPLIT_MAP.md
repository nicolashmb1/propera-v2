# Propera MAIN — File Split Map

**Purpose:** Map the current ~20K-line `PROPERA MAIN.gs` into logical files for maintainability.  
**Scope:** Architecture after Phase 1 Inner Operational Domain Router (Compass).  
**Constraint:** Google Apps Script single global scope; no ES modules. File order (e.g. alphabetical) determines load order; dependents must load after dependencies.

---

## 1. Current Architecture (Summary)

| Marker / Section | Approx. Lines | Description |
|------------------|---------------|-------------|
| Header + Config | 1–75 | Compass header, `props`, Twilio/Comm globals, `onOpen`, `showMessageEmulator_`, `dbg_`, `withWriteLock_` |
| Directory + Issue helpers | 77–535 | `dirSet_`, issue normalizer, mixed extractors, clause helpers, schema gates, OpenAI cooldown, `openaiChatJson_` |
| **Media / Image Signal** | 536–866 | `extractInboundMediaFacts_`, `imageSignalAdapter_`, `mergeMediaIntoBody_`, `maybeAttachMediaFactsToTurn_`, vision/attachment helpers |
| **Attachments + Schema + Issue scoring** | 867–1647 | Drive attachment helpers, `extractIssuesSchema_`, `applySchemaIssuesToDraft_`, clause scoring, `normalizeIssueTitle_`, `buildIssueDetails_`, urgency/subcategory |
| **M5 — Draft Accumulator** | 1648–2041 | `draftUpsertFromTurn_`, `getLogSheet_` |
| **Recompute + M6 — State Resolver** | 2042–2453 | `recomputeDraftExpected_`, `resolveEffectiveTicketState_`, `draftDecideNextStage_`, issue buffer, `appendIssueBufferItem_` |
| **M4 — Compiler** | 2454–2592 | `compileTurn_` |
| **Finalize + WorkItem assignment** | 2593–3140 | `resolveWorkItemAssignment_`, `resolveAssigneeDisplayName_`, `finalizeDraftAndCreateTicket_` |
| **Portal PM API** | 3140–3555 | `portalPmCreateTicketFromForm_`, ticket finders, `portalPmAddAttachmentToTicket_`, update/complete/delete |
| **Manager ticket creator** | 3556–3737 | `looksLikeNewIssueIntent_`, `mgrCreateTicketForTenant_` |
| **Work Engine + Ops Domain Router** | 3738–4515 | WorkItems/Sessions/Context constants, `getOrCreateSheet_`, `ensureVisitsSheet_`, `workItemCreate_`/Get/Update, **Ops router**: `inferCleaningSubtype_`, `getOperationalDomainSlots_`, `buildDomainSignal_`, `routeOperationalDomain_`, `dispatchOperationalDomain_`, `createCleaningWorkItemFromDomain_`, `clearMaintenanceDraftResidue_` |
| **Context + Session DAL** | 4516–5051 | `ctxGet_`/`ctxUpsert_`, `sessionGet_`/`sessionUpsert_`, `findWorkItemIdByTicketRow_`, `wiTransition_`, `wiSetWaitTenant_` |
| **M2 — Router** | 5051–5740 | `detectTenantCommand_`, `handleTenantCommandGlobal_`, `handleSmsRouter_`, `routeToCoreSafe_`, compliance, lane/amenity/leasing gates |
| **M1 — Gateway** | 5741–6292 | `doPost`, Portal/AppSheet routes, Twilio validation |
| **Router body + Gateway flow** | 6293–7460 | `handleSmsRouter_` body, `routeToCoreSafe_`, dedupe layers, directory lookup, staff capture, manager new ticket, vendor command |
| **Sheet/cache + COL + processTicket_** | 7462–9445 | `LOG_SHEET_ID`, `SHEET_NAME`, `COL`, sheet caches, `processTicket_`, PT flow, DevSmsLog, Chaos, `tenantMsg_`/`tenantMsgSafe_`, `renderTenantKey_` (M8 start) |
| **M8 — Messaging** | 9446–~12335 | Template allowlist, `renderTenantKey_`, `getTemplateMapCached_`, `tenantMsg_` fallbacks, sanitize, compliance footer |
| **Ticket DAL + Location + finalize tail** | ~12336–13236 | `getTicketSummary_`, `resolveTicketRow_`, location inference (`inferLocationTypeDeterministic_`, `inferLocationType_`, `inferLocationScope_`), finalize/processTicket_ tail |
| **M3 — Core Pipeline** | 13237–20073 | `classifyTenantSignals_`, **`handleSmsCore_`** (orchestrator: compileTurn → domain signal → early cleaning → draft → resolver → stage handlers M7, NEW_TICKET_FLOW, vendor confirmation, etc.) |

---

## 2. Proposed File Split

Split by **domain** and **dependency order**. Names use a prefix so load order is clear (e.g. `00_` before `01_`).

| File | Approx. Lines | Contents | Deps |
|------|----------------|----------|------|
| **00_Config.gs** | ~120 | Compass header, `props`, Twilio/Comm/ONCALL globals, `commWebhookSecret_`, `onOpen`, `showMessageEmulator_`, `BRAND` if any | None |
| **01_Utils.gs** | ~180 | `dbg_`, `withWriteLock_`, `safeParam_`, `normalizePhone_`, `normalizePhoneDigits_`, `getSheet_`, `hashText_`, `singleLine_`, phone/sheet helpers used everywhere | 00_Config |
| **02_DAL.gs** | ~550 | Directory: `DIR_COL`, `dalWithLock_`, `dalGet*`/`dalSet*` (PendingIssue, PendingUnit, PendingRow, PendingStage, LastUpdated, Property), `dirSet_`, `getDirPendingStage_`/`setDirPendingStage_`, `getIssueBuffer_`, `setIssueBuffer_`, `appendIssueBufferItem_`, `migrateDirIssueBufFromHandoff_` | 01_Utils |
| **03_IssueParser.gs** | ~520 | Issue normalizer, mixed extractors, clause split/score, `parseIssueDeterministic_`, `extractIssuePayload_`, `stripIssuePreamble_`, `hasIssueNounKeyword_`, `classifyIssueClauseType_`, `scoreIssueClause*`, `normalizeIssueTitle_`, `buildIssueDetails_`, `detectSubcategory_`, `detectUrgency_`, schema gates (`shouldUseSchemaExtract_`, `extractIssuesSchema_`, `applySchemaIssuesToDraft_`) | 01_Utils, 02_DAL |
| **04_OpenAI.gs** | ~120 | `openaiCooldownKey_`/`Active`/`SetCooldown`, global cooldown get/set, `openaiChatJson_`, `openaiVisionJson_` (if shared), `_nosidDigest_` | 01_Utils |
| **05_MediaSignal.gs** | ~340 | `extractInboundMediaFacts_`, `buildMediaSignalPrompt_`, `fetchTwilioMediaAsDataUrl_`, `openaiVisionJson_` (if here), `imageSignalAdapter_`, `mergeMediaIntoBody_`, `maybeAttachMediaFactsToTurn_`, `extractTicketMediaWritePayload_`, `isTrustworthyMediaTenantName_`, `sanitizeSyntheticBodyFromMedia_` | 01_Utils, 04_OpenAI |
| **06_Attachments.gs** | ~380 | `getProperaAttachmentsFolder_`, `guessAttachmentKindFromMediaFacts_`, `guessAttachmentExtFromMime_`, `sanitizeAttachmentNamePart_`, `buildReadableAttachmentFilename_`, `fetchTwilioMediaBlob_`, `extractAttachmentDisplayMeta_`, `saveInboundAttachmentToDrive_` | 01_Utils, 05_MediaSignal |
| **07_DraftAndResolver.gs** | ~800 | M5: `draftUpsertFromTurn_`; `recomputeDraftExpected_`; M6: `resolveEffectiveTicketState_`, `draftDecideNextStage_`, `mergedIssueFromBuffer_`, `issueTextKey_`; `getLogSheet_` | 02_DAL, 03_IssueParser |
| **08_Compiler.gs** | ~150 | M4: `compileTurn_` (property/unit/issue/schedule extraction, intent) | 02_DAL, 03_IssueParser, 01_Utils |
| **09_WorkEngine.gs** | ~800 | WorkItems/Sessions/Context sheet names and constants; `OPS_DOMAIN`, router flags; `getOrCreateSheet_`, `ensureVisitsSheet_`, `createVisit_`, `getHeaderMap_`, `col_`, `findRowByValue_`, `ensureWorkBackbone_`, `workItemCreate_`/`GetById`/`Update`; **Ops router:** `inferCleaningSubtype_`, `getOperationalDomainSlots_`, `buildDomainSignal_`, `routeOperationalDomain_`, `dispatchOperationalDomain_`, `createCleaningWorkItemFromDomain_`, `clearMaintenanceDraftResidue_`; `isLangCode_`, `sanitizeCtxPatch_`, `ctxGet_`, `ctxUpsert_`; Session COL and `session*`; `getPropertyIdByCode_`, `syncActiveWorkItemFromTicketRow_`, `findWorkItemIdByTicketRow_`, `wiTransition_`, `wiSetWaitTenant_` | 01_Utils, 02_DAL |
| **10_FinalizeAndPortal.gs** | ~950 | `resolveWorkItemAssignment_`, `resolveAssigneeDisplayName_`, `finalizeDraftAndCreateTicket_`; Portal PM: `portalPmCreateTicketFromForm_`, `findTicketRowByTicketId_`/`findTicketRowsByTicketId_`, `portalPmAddAttachmentToTicket_`, `portalPmUpdateTicket_`, `portalPmCompleteTicket_`, `portalPmDeleteTicket_`; `looksLikeNewIssueIntent_`, `mgrCreateTicketForTenant_` | 02_DAL, 07_DraftAndResolver, 08_Compiler, 09_WorkEngine |
| **11_SheetsAndTicketDAL.gs** | ~750 | `LOG_SHEET_ID`, `DEV_MODE`, `DEV_REQ_`, sheet caches (`__SS_CACHE__`, `__SH_CACHE__`, `ssByIdCached_`, `sheetFromSsCached_`, `getLogSheetByNameCached_`, `getActiveSheetByNameCached_`), `SHEET_NAME`, `DIRECTORY_SHEET_NAME`, `COL`, `MAX_COL`, ticket DAL helpers (`getTicketSummary_`, `resolveTicketRow_`, etc.), `processTicket_` (full) | 01_Utils, 02_DAL, 09_WorkEngine, 10_FinalizeAndPortal |
| **12_Location.gs** | ~220 | `inferLocationTypeClauses_`, `inferLocationTypeIssueScore_`, `inferLocationTypeDominantClause_`, `inferLocationTypeOnClause_`, `inferLocationTypeDeterministic_`, `inferLocationType_` (LLM), `inferLocationScope_`, `normalizeUnit_` | 01_Utils, 04_OpenAI |
| **13_Messaging.gs** | ~400 | M8: `TEMPLATES_SHEET_NAME`, `getTemplateMapCached_`, `tenantMsg_` (with fallbacks e.g. `TICKET_CREATED_COMMON_AREA`, `CLEANING_WORKITEM_ACK`), `tenantMsgSafe_`, `renderTenantKey_`, `sanitizeTemplateBody_`, `renderTemplatePlaceholders_`, allowlists (`shouldPrependWelcome_`, `shouldAppendCompliance_`), `sanitizeTenantText_` | 01_Utils |
| **14_Router.gs** | ~750 | M2: `detectTenantCommand_`, `listMyTickets_`, `handleTenantCommandGlobal_`, `handleSmsRouter_`, `routeToCoreSafe_`, compliance intent, opt-out check, lane detection, amenity/leasing direct routing, intent gate (INTENT_PICK/UNKNOWN_GATE) | 01_Utils, 02_DAL, 09_WorkEngine, 11_SheetsAndTicketDAL, 13_Messaging |
| **15_Gateway.gs** | ~600 | M1: `doPost`, Portal path delegate, AppSheet JSON route, Twilio validation, webhook secret, normalization; `debugLogToSheet_` | 01_Utils, 14_Router |
| **16_CorePipeline.gs** | ~6800 | M3: `classifyTenantSignals_`, **`handleSmsCore_`** (entire function: directory touch, lang, media merge, compileTurn, domain signal, early cleaning dispatch, cap, draft accumulator, resolver, stage guards, tenant commands, dedupe, NEW_TICKET_FLOW, M7 stage handlers, finalize, vendor confirmation, etc.). Remains one file because it is one giant orchestration function; splitting the function itself would require passing many locals or refactoring into smaller orchestration helpers. | All of the above |
| **17_DevLogAndMisc.gs** | ~400 | `logDevSms_`, `flushDevSmsLogs_`, DevSmsLog buffer, Chaos timeline, `writeTimeline_`, `setRowCol_`, other one-off helpers used only from Core or Router | 01_Utils, 11_SheetsAndTicketDAL |

**Optional (further split of 16):**

- **16a_CoreOrchestrator.gs** — Only `handleSmsCore_` entry and the barest flow (call compileTurn, build domain signal, call draft, resolver, then delegate to stage handler module).
- **16b_StageHandlers.gs** — All stage blocks (PROPERTY, UNIT, ISSUE, SCHEDULE, SCHEDULE_DRAFT_MULTI, DETAIL, NEW_TICKET_FLOW, continuation, vendor confirm).  
  This requires passing a context object (sheet, dir, dirRow, phone, turnFacts, ticketState, etc.) or moving those into a shared closure. Higher refactor cost.

---

## 3. Shared Globals and Constants

These are referenced across files; keep in **00_Config.gs** or the first file that needs them, and ensure load order so they exist when used.

| Symbol | Where to define | Used by |
|--------|-----------------|--------|
| `props`, `TWILIO_*`, `ONCALL_NUMBER`, `COMM_WEBHOOK_SECRET` | 00_Config | Gateway, Router, Core, Messaging |
| `BRAND` (if exists) | 00_Config | Messaging |
| `LOG_SHEET_ID`, `SHEET_NAME`, `DIRECTORY_SHEET_NAME`, `COL` | 11_SheetsAndTicketDAL | DAL, Finalize, Router, Core, processTicket_ |
| `DIR_COL` | 02_DAL | DAL, Draft, Compiler, Finalize, Ops router |
| `WORKITEMS_SHEET`, `CTX_SHEET`, `SESSIONS_SHEET`, `OPS_DOMAIN`, `OPS_DOMAIN_ROUTER_ENABLED`, `OPS_CLEANING_LIVE_DIVERT_ENABLED` | 09_WorkEngine | Core, Finalize, Router |
| `SESSION_COL` | 09_WorkEngine | Session DAL, Draft, Core |
| `TEMPLATES_SHEET_NAME` | 13_Messaging | Messaging, Core |
| `logDevSms_`, `flushDevSmsLogs_` | 17_DevLogAndMisc | Almost every module |

---

## 4. Dependency Graph (Load Order)

```
00_Config
  → 01_Utils
      → 02_DAL
      → 04_OpenAI
  → 03_IssueParser (Utils, DAL)
  → 05_MediaSignal (Utils, 04_OpenAI)
  → 06_Attachments (Utils, 05_MediaSignal)
  → 07_DraftAndResolver (DAL, 03_IssueParser)
  → 08_Compiler (DAL, 03_IssueParser, Utils)
  → 09_WorkEngine (Utils, DAL)
  → 10_FinalizeAndPortal (DAL, 07, 08, 09)
  → 11_SheetsAndTicketDAL (Utils, DAL, 09, 10)
  → 12_Location (Utils, 04_OpenAI)
  → 13_Messaging (Utils)
  → 17_DevLogAndMisc (Utils, 11)
  → 14_Router (Utils, DAL, 09, 11, 13)
  → 15_Gateway (Utils, 14_Router)
  → 16_CorePipeline (all)
```

Recommended file naming so alphabetical order matches this:  
`00_Config.gs`, `01_Utils.gs`, `02_DAL.gs`, … , `17_DevLogAndMisc.gs`, then `14_Router.gs`, `15_Gateway.gs`, `16_CorePipeline.gs` (or use Apps Script manifest to set file order if supported).

---

## 5. Migration Order and Risks

1. **Phase A — Extract read-only / low-risk**
   - Create `00_Config.gs`, `01_Utils.gs`, move only those; run tests.
   - Then `04_OpenAI.gs`, `12_Location.gs`, `13_Messaging.gs`, `17_DevLogAndMisc.gs`.
2. **Phase B — DAL and parsing**
   - `02_DAL.gs`, `03_IssueParser.gs`, `07_DraftAndResolver.gs`, `08_Compiler.gs`.
3. **Phase C — Work engine and finalize**
   - `09_WorkEngine.gs`, `10_FinalizeAndPortal.gs`, `11_SheetsAndTicketDAL.gs`.
4. **Phase D — Media and attachments**
   - `05_MediaSignal.gs`, `06_Attachments.gs`.
5. **Phase E — Router and Gateway**
   - `14_Router.gs`, `15_Gateway.gs`.
6. **Phase F — Core**
   - Move only the **non–handleSmsCore_** parts from MAIN into the new files above; leave `handleSmsCore_` and `classifyTenantSignals_` in a single file (e.g. `16_CorePipeline.gs`). Then delete the moved code from MAIN and keep MAIN as a thin wrapper that only contains `handleSmsCore_` + `classifyTenantSignals_` and any small glue, **or** rename MAIN to `16_CorePipeline.gs` and remove the duplicated logic already moved.

**Risks:**
- **Global references:** Any `function` or `const` that another file expects must remain in scope; avoid renaming or moving without updating every reference.
- **Execution order:** Apps Script runs all .gs files in one project; ensure no code runs at top level that depends on a symbol defined in a file that loads later.
- **handleSmsCore_** is ~6.8K lines and has hundreds of local variables and closures; do not split the function body across files without a refactor (e.g. context object + stage handler modules).

---

## 6. Quick Reference — “Where does X live?”

| Topic | Target file |
|-------|-------------|
| Twilio/Comm config, menu | 00_Config |
| Locks, phone normalize, safeParam | 01_Utils |
| Directory columns, dal* | 02_DAL |
| Issue parsing, schema extract, clause scoring | 03_IssueParser |
| OpenAI chat/vision, cooldown | 04_OpenAI |
| Image signal, merge media into body | 05_MediaSignal |
| Drive attachments | 06_Attachments |
| Draft upsert, recompute expected, state resolver | 07_DraftAndResolver |
| compileTurn_ | 08_Compiler |
| WorkItems, Context, Sessions, Ops domain router, cleaning | 09_WorkEngine |
| finalizeDraftAndCreateTicket_, Portal PM, mgrCreateTicket | 10_FinalizeAndPortal |
| LOG_SHEET_ID, COL, sheet caches, processTicket_ | 11_SheetsAndTicketDAL |
| Location inference (UNIT/COMMON_AREA, refined) | 12_Location |
| Templates, tenantMsg_, renderTenantKey_ | 13_Messaging |
| handleSmsRouter_, routeToCoreSafe_, tenant commands | 14_Router |
| doPost, Gateway | 15_Gateway |
| handleSmsCore_, classifyTenantSignals_ | 16_CorePipeline |
| logDevSms_, flushDevSmsLogs_, Chaos | 17_DevLogAndMisc |

---

*Generated from current PROPERA MAIN.gs structure (Post–Phase 1 Ops Domain Router).*
