// ===================================================================
// PROPERA COMPASS ARCHITECTURE
// Canonical Flow:
// Gateway → Router → Core Pipeline → Compiler → Draft → Resolver → Workflow → Messaging
//
// Patch Law:
// - Every patch MUST target a single module.
// - No cross-module side effects.
//
// This file (01_PROPERA MAIN.gs) is the thin shell: script globals, sheet constants, and Sheets UI only.
// Runtime logic lives in CANONICAL_INTAKE_ENGINE, *_ENGINE, *_DAL, etc. (split plan phases 0–8+).
// ===================================================================

/************************************
 * PROPERA — GLOBAL CONFIG
 ************************************/

const props = PropertiesService.getScriptProperties();

// ---- Twilio (SMS ingress / egress)
const TWILIO_SID = props.getProperty("TWILIO_SID");
const TWILIO_TOKEN = props.getProperty("TWILIO_TOKEN");
const TWILIO_NUMBER = props.getProperty("TWILIO_NUMBER");
// WhatsApp Sandbox sender (Twilio sandbox). Later: make this per-tenant config (Directory/Settings).
var TWILIO_WA_FROM = "whatsapp:+14155238886";
const ONCALL_NUMBER = props.getProperty("ONCALL_NUMBER");
const TWILIO_WEBHOOK_SECRET = props.getProperty("TWILIO_WEBHOOK_SECRET");

// ---- Internal webhooks (AppSheet / Comm Engine)
const COMM_WEBHOOK_SECRET = props.getProperty("COMM_WEBHOOK_SECRET");

function commWebhookSecret_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty("COMM_WEBHOOK_SECRET") || "");
  } catch (_) {
    return "";
  }
}

/************************************
 * PROPERA — SHEETS UI (sidebar emulator)
 ************************************/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Propera")
    .addItem("Open Message Emulator", "showMessageEmulator_")
    .addToUi();
}

function showMessageEmulator_() {
  var html = HtmlService.createHtmlOutputFromFile("MessageEmulator")
    .setTitle("Message Emulator")
    .setWidth(360);
  SpreadsheetApp.getUi().showSidebar(html);
}

/***********************
 * Maintenance AI Triage (SMS ONLY)
 * Google Sheets + Twilio + OpenAI
 *
 * Twilio Messaging Webhook (SMS):
 *   POST -> https://script.google.com/macros/s/<DEPLOY_ID>/exec
 *
 * Sheets:
 *  - Ticket log tab: "Sheet1"
 *  - Directory tab:  "Directory"
 *
 * Directory columns (A:I): A Phone, B PropertyCode, C PropertyName, D UpdatedAt,
 *  E PendingIssue, F PendingUnit, G PendingRow, H PendingStage, I IssueBuffer (JSON)
 ***********************/

// IMPORTANT: Twilio webhooks MUST always return valid TwiML XML.

const LOG_SHEET_ID = (PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID")) || "";

const DEV_MODE = false;                 // true = no real SMS sent; logs only

// Request-scoped dev/dryrun flag (default false)
var DEV_REQ_ = false;
function devReqOn_()  { DEV_REQ_ = true; }
function devReqOff_() { DEV_REQ_ = false; }
// Use this everywhere instead of DEV_MODE directly for sending
function isDevSendMode_() {
  return !!DEV_MODE || !!DEV_REQ_;
}

// ============================================================
// SHEET HANDLE CACHE (per execution)
// - Object stores only; helpers (ssByIdCached_, etc.) live in PROPERTY_SCHEDULE_ENGINE.gs
// ============================================================
var __SS_CACHE__ = {};     // key -> Spreadsheet
var __SH_CACHE__ = {};     // key -> Sheet
var __CTX_CACHE__ = {};

const BUILD_MARKER = "2026-02-FINALIZE";  // change when deploying to confirm version
const SHEET_NAME = "Sheet1";           // ticket log tab name EXACTLY
const DIRECTORY_SHEET_NAME = "Directory";
const TENANTS_SHEET_NAME = "Tenants";
const MGR_NEW_TICKET_PREFIX = "__MGR_NEW_TICKET__";
const AMENITIES_SHEET_NAME = "Amenities";
const AMENITY_RES_SHEET_NAME = "AmenityReservations";
const AMENITY_DIR_SHEET_NAME = "AmenityDirectory";
const VISITS_SHEET_NAME = "Visits";

const DEFAULT_GAMEROOM_KEY = "PENN_GAMEROOM";

const MAX_COL = 55; // keep in sync with the last COL.* index

// Ticket log column positions (1-indexed). Must match your Sheet1 columns order:
// Timestamp(1), Phone(2), Property(3), Unit(4), Message(5), Category(6), Emergency(7),
// EmergencyType(8), Confidence(9), NextQuestions(10), AutoReplySent(11), EscalatedToYou(12), ThreadId(13)
const COL = {
  TS: 1,                     // Timestamp
  PHONE: 2,                  // Phone
  PROPERTY: 3,               // Property
  UNIT: 4,                   // Unit
  MSG: 5,                    // Message
  CAT: 6,                    // Category
  EMER: 7,                   // Emergency
  EMER_TYPE: 8,              // Emergency Type
  URG: 9,                    // Urgency
  URG_REASON: 10,            // UrgencyReason
  CONF: 11,                  // Confidence
  NEXT_Q: 12,                // Next Question
  REPLY_SENT: 13,            // AutoReply
  ESCALATED: 14,             // EscaletedToYou
  THREAD_ID: 15,             // ThreadId

  TICKET_ID: 16,             // TicketID
  STATUS: 17,                // Status
  ASSIGNED_TO: 18,           // AssignedTo
  DUE_BY: 19,                // DueBy
  LAST_UPDATE: 20,           // LastUpdateAt
  PREF_WINDOW: 21,           // PreferredWindow
  HANDOFF_SENT: 22,          // HandoffSent

  // AppSheet / Ops fields — Z=26 ClosedAt, AA=27 CreatedAt (do not swap)
  CAT_FINAL: 23,             // CategoryFinal
  PRIORITY: 24,              // Priority
  SERVICE_NOTES: 25,         // ServiceNotes
  CLOSED_AT: 26,             // ClosedAt (col Z)
  CREATED_AT: 27,            // CreatedAt (col AA)
  ATTACHMENTS: 28,           // Attachments

  // SMS flags
  COMPLETED_SENT: 29,        // CompletedMsgSent
  COMPLETED_SENT_AT: 30,     // CompleteMsgSentAt
  CREATED_MSG_SENT: 31,      // CreatedMsgSent
  CREATED_MSG_SENT_AT: 32,   // CreatedMsgSentAt
  CREATED_BY_MANAGER: 33,    // CreatedByManager
  CANCEL_MSG_SENT: 34,       // CancelMsgSent
  CANCEL_MSG_SENT_AT: 35,    // CancelMsgSentAt

  // Identity / internal
  PROPERTY_ID: 36,           // PropertyID
  UNIT_ID: 37,               // UnitID
  LOCATION_TYPE: 38,         // LocationType
  WORK_TYPE: 39,             // WorkType
  RESIDENT_ID: 40,           // ResidentID
  UNIT_ISSUE_COUNT: 41,      // UnitIssueCount
  TARGET_PROPERTY_ID: 42,    // TargetPropertyID

  // ASSIGNMENT SYSTEM
  ASSIGNED_TYPE: 43,         // AssignedType   ("Vendor" | "Staff")
  ASSIGNED_ID: 44,           // AssignedID
  ASSIGNED_NAME: 45,         // AssignedName
  ASSIGNED_AT: 46,           // AssignedAt
  ASSIGNED_BY: 47,           // AssignedBy

  VENDOR_STATUS: 48,         // VendorStatus
  VENDOR_APPT: 49,           // VendorAppt
  VENDOR_NOTES: 50,           // VendorNotes
  TICKET_KEY: 51,             // TicketKey (UUID, immutable)
  VISIT_ID: 52,               // VisitId (links to Visits sheet for parent visit + child tickets)
  OWNER_ACTION: 53,           // OwnerAction
  OWNER_ACTION_AT: 54,        // OwnerActionAt
  SCHEDULED_END_AT: 55        // ScheduledEndAt — structured end datetime from parsed schedule
};
