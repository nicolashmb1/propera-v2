/**
 * LEASING_ENGINE.gs
 * Leasing flow: availability, tours, lifecycle.
 * Extracted from PROPERA MAIN.gs to reduce file size.
 * Depends on: getSheet_, withWriteLock_, getHeaderMap_, findRowByValue_,
 *   phoneKey_, renderTenantKey_, sendRouterSms_, logDevSms_, workItemCreate_ (from MAIN).
 */
/************************************
 * PHASE 1: LEASING ENGINE
 * Propera Compass - Occupancy-First Architecture
 * - Unit.OccupancyState as source of truth
 * - LeasingSession as the brain
 * - Natural language + deterministic parsing
 * - Compass-aligned (locks, templates, WorkItems)
 ************************************/

// ========== CONFIGURATION ==========

const LEASING_CONFIG = {
  // Configure your portfolio property codes here (used for deterministic parsing)
  PROPERTY_CODES: ["PENN","MORRIS","WESTFIELD","MURRAY","WESTGRAND"],
  DEFAULT_PROPERTY_CODE: "PENN",

  TOUR_DURATION_MIN: 30,
  TOUR_HOURS_START: "09:00",
  TOUR_HOURS_END: "18:00",
  MAX_TOURS_PER_UNIT_PER_DAY: 8,
  THREAD_EXPIRE_HOURS: 24,
  LIFECYCLE_MAX_ROWS: 25
};

const LEASING_SHEETS = {
  UNITS: "UnitsDirectory",
  SESSIONS: "LeasingSessions",
  CONTACTS: "Contacts",
  THREADS: "LeasingThreads",
  TOURS: "TourBookings"
};

function tourHoursDisplay_() {
  const s = String(LEASING_CONFIG.TOUR_HOURS_START || "09:00");
  const e = String(LEASING_CONFIG.TOUR_HOURS_END || "18:00");
  // Keep simple GSM-safe format
  return s + "-" + e;
}

function isTimeWithinTourHours_(hours, minutes) {
  const h = parseInt(hours, 10);
  const m = parseInt(minutes, 10);
  if (isNaN(h) || isNaN(m)) return false;

  const startParts = String(LEASING_CONFIG.TOUR_HOURS_START || "09:00").split(":");
  const endParts = String(LEASING_CONFIG.TOUR_HOURS_END || "18:00").split(":");

  const startH = parseInt(startParts[0], 10) || 9;
  const startM = parseInt(startParts[1], 10) || 0;
  const endH = parseInt(endParts[0], 10) || 18;
  const endM = parseInt(endParts[1], 10) || 0;

  const t = (h * 60) + m;
  const startT = (startH * 60) + startM;
  const endT = (endH * 60) + endM;

  // allow start times within [start, end - duration]
  const latestStart = endT - (LEASING_CONFIG.TOUR_DURATION_MIN || 30);
  return t >= startT && t <= latestStart;
}

const OCCUPANCY_STATES = {
  READY: "READY",
  MARKETING: "MARKETING",
  LEASING_ACTIVE: "LEASING_ACTIVE",
  COMMITTED: "COMMITTED",
  OCCUPIED: "OCCUPIED"
};

const LEASING_STAGES = {
  AVAILABILITY: "LEASING_AVAILABILITY",
  PICK_UNIT: "LEASING_PICK_UNIT",
  PICK_DAY: "LEASING_PICK_DAY",
  PICK_TIME: "LEASING_PICK_TIME",
  CONFIRM_TOUR: "LEASING_CONFIRM_TOUR"
};

// ========== NATURAL LANGUAGE PARSERS ==========

/**
 * Extract unit number from natural text
 * Handles: "305", "unit 305", "apartment 305", "apt 305", "#305", "2-305"
 */
function extractUnitNumber_(text) {
  const patterns = [
    /\b(?:unit|apt|apartment|#|number|num)?\s*([0-9]{3,4})\b/i,
    /\b([0-9]{1})-([0-9]{3})\b/
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = match[match.length - 1];
      return String(num).padStart(3, '0');
    }
  }
  
  return null;
}


function extractPropertyCode_(text) {
  const t = String(text || "").toUpperCase();
  const codes = (LEASING_CONFIG.PROPERTY_CODES || []).map(c => String(c || "").toUpperCase());
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c && t.indexOf(c) !== -1) return c;
  }
  return "";
}

function resolvePropertyCode_(bodyTrim, ctx) {
  // Priority: explicit in message -> ctx.propertyCode -> default
  const msgPc = extractPropertyCode_(bodyTrim);
  const ctxPc = ctx && ctx.propertyCode ? String(ctx.propertyCode).toUpperCase().trim() : "";
  return msgPc || ctxPc || LEASING_CONFIG.DEFAULT_PROPERTY_CODE;
}

function propertyDisplayName_(propertyCode) {
  // Phase 1: simple. Later, map to Properties sheet.
  const pc = String(propertyCode || "").toUpperCase();
  return pc;
}

/**
 * Extract confirmation (yes/no)
 * Handles: yes, yeah, yep, sure, ok vs no, nah, cancel, nope
 */
function extractConfirmation_(text) {
  const lower = text.toLowerCase().trim();
  
  if (lower.match(/\b(yes|yeah|yep|yup|sure|ok|okay|confirm|good|sounds good|perfect)\b/)) {
    return "YES";
  }
  
  if (lower.match(/\b(no|nah|nope|cancel|stop|nevermind|never mind)\b/)) {
    return "NO";
  }
  
  return null;
}

/**
 * Extract day preference
 * Handles: "tomorrow", "tuesday", "tue", "next wednesday", "this friday"
 */
function extractDayPreference_(text) {
  const lower = text.toLowerCase();
  const now = new Date();
  
  // Tomorrow (accept common typo variants)
  if (lower.match(/\b(tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr)\b/)) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
  }
  
  // Day names
  const dayPatterns = {
    "monday": 1, "mon": 1,
    "tuesday": 2, "tue": 2, "tues": 2,
    "wednesday": 3, "wed": 3,
    "thursday": 4, "thu": 4, "thur": 4, "thurs": 4,
    "friday": 5, "fri": 5,
    "saturday": 6, "sat": 6,
    "sunday": 0, "sun": 0
  };
  
  for (const [dayName, targetDay] of Object.entries(dayPatterns)) {
    if (lower.includes(dayName)) {
      const currentDay = now.getDay();
      let daysAhead = targetDay - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      
      const targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + daysAhead);
      targetDate.setHours(0, 0, 0, 0);
      return targetDate;
    }
  }
  
  return null;
}

/**
 * Extract time preference
 * Handles: "2pm", "2:00pm", "14:00", "afternoon", "morning"
 */
function extractTimePreference_(text) {
  const lower = text.toLowerCase();
  
  // Explicit times: "2pm", "2:00pm", "14:00"
  const timePattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i;
  const match = lower.match(timePattern);
  
  if (match) {
    let hours = parseInt(match[1]);
    const minutes = match[2] ? parseInt(match[2]) : 0;
    const meridiem = match[3] ? match[3].toLowerCase().replace(/\./g, '') : null;
    
    // Convert to 24-hour
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    
    // If no meridiem and hours < 8, assume PM
    if (!meridiem && hours > 0 && hours < 8) hours += 12;
    
    return { hours, minutes };
  }
  
  // Relative times
  if (lower.match(/\bmorning\b/)) return { hours: 10, minutes: 0 };
  if (lower.match(/\bafternoon\b/)) return { hours: 14, minutes: 0 };
  if (lower.match(/\bevening\b/)) return { hours: 17, minutes: 0 };
  
  return null;
}

/**
 * Combined parser: extract day + time
 */
function parseScheduleIntent_(text) {
  return {
    day: extractDayPreference_(text),
    time: extractTimePreference_(text)
  };
}

// ========== DATA ACCESS LAYER (DAL) ==========

function leasingDal_() {
  return {
    // ===== UNITS =====
    units: {
      findAvailable: function(propertyCode, filters) {
        const sheet = getSheet_(LEASING_SHEETS.UNITS);
        const lastRow = sheet.getLastRow();
        if (lastRow < 2) return [];
        
        const map = getHeaderMap_(sheet);
        const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
        
        const results = [];
        
        for (let i = 0; i < data.length; i++) {
          const state = String(data[i][map["OccupancyState"] - 1] || "");
          const property = String(data[i][map["PropertyCode"] - 1] || "");
          
          // Must be in marketing states
          if (state !== OCCUPANCY_STATES.MARKETING && state !== OCCUPANCY_STATES.LEASING_ACTIVE) {
            continue;
          }
          
          // Property filter
          if (propertyCode && property !== propertyCode) {
            continue;
          }

          // Available now filter (safe)
          if (filters && filters.availableNowOnly) {
            const ad = data[i][map["AvailableDate"] - 1];
            if (ad) {
              const dt = new Date(ad);
              const today = new Date();
              today.setHours(0,0,0,0);
              dt.setHours(0,0,0,0);
              if (dt.getTime() > today.getTime()) continue;
            }
          }
          
          // Budget filter
          if (filters && filters.maxRent) {
            const rent = Number(data[i][map["BaseRent"] - 1] || 0);
            if (rent > filters.maxRent) continue;
          }
          
          // Unit type filter
          if (filters && filters.unitType) {
            const type = String(data[i][map["UnitType"] - 1] || "");
            if (type !== filters.unitType) continue;
          }
          
          results.push({
            unitId: String(data[i][map["UnitID"] - 1] || ""),
            propertyCode: property,
            unitNumber: String(data[i][map["UnitNumber"] - 1] || ""),
            unitType: String(data[i][map["UnitType"] - 1] || ""),
            rent: Number(data[i][map["BaseRent"] - 1] || 0),
            availableDate: data[i][map["AvailableDate"] - 1] || "",
            state: state
          });
        }
        
        return results;
      },
      
      getById: function(unitId) {
        const sheet = getSheet_(LEASING_SHEETS.UNITS);
        const row = findRowByValue_(sheet, "UnitID", unitId);
        if (!row) return null;
        
        const map = getHeaderMap_(sheet);
        const data = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
        
        return {
          unitId: String(data[map["UnitID"] - 1] || ""),
          propertyCode: String(data[map["PropertyCode"] - 1] || ""),
          unitNumber: String(data[map["UnitNumber"] - 1] || ""),
          unitType: String(data[map["UnitType"] - 1] || ""),
          rent: Number(data[map["BaseRent"] - 1] || 0),
          state: String(data[map["OccupancyState"] - 1] || ""),
          availableDate: data[map["AvailableDate"] - 1] || "",
          sessionId: String(data[map["LeasingSessionID"] - 1] || "")
        };
      },
      
      updateState: function(unitId, newState) {
        return withWriteLock_("LEASING_UNIT_STATE", () => {
          const sheet = getSheet_(LEASING_SHEETS.UNITS);
          const row = findRowByValue_(sheet, "UnitID", unitId);
          if (!row) return false;
          
          const map = getHeaderMap_(sheet);
          sheet.getRange(row, map["OccupancyState"]).setValue(newState);
          sheet.getRange(row, map["UpdatedAt"]).setValue(new Date());
          
          return true;
        });
      }
    },
    
    // ===== SESSIONS =====
    sessions: {
      findOrCreate: function(unitId) {
        const sheet = getSheet_(LEASING_SHEETS.SESSIONS);
        const map = getHeaderMap_(sheet);
        
        // Find existing open session
        const lastRow = sheet.getLastRow();
        if (lastRow >= 2) {
          const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
          
          for (let i = 0; i < data.length; i++) {
            const rowUnit = String(data[i][map["UnitID"] - 1] || "");
            const rowStatus = String(data[i][map["Status"] - 1] || "");
            
            if (rowUnit === unitId && rowStatus === "OPEN") {
              return String(data[i][map["SessionID"] - 1] || "");
            }
          }
        }
        
        // Create new session
        return withWriteLock_("LEASING_SESSION_CREATE", () => {
          const sessionId = "SESS-" + new Date().getTime();
          const now = new Date();
          
          sheet.appendRow([
            sessionId,
            unitId,
            "OPEN",
            "MARKETING",
            JSON.stringify({ views: 0, tours: 0, apps: 0 }),
            now,
            now
          ]);
          
          // Update unit
          const unitSheet = getSheet_(LEASING_SHEETS.UNITS);
          const unitRow = findRowByValue_(unitSheet, "UnitID", unitId);
          if (unitRow) {
            const unitMap = getHeaderMap_(unitSheet);
            unitSheet.getRange(unitRow, unitMap["LeasingSessionID"]).setValue(sessionId);
          }
          
          return sessionId;
        });
      },
      
      close: function(sessionId) {
        return withWriteLock_("LEASING_SESSION_CLOSE", () => {
          const sheet = getSheet_(LEASING_SHEETS.SESSIONS);
          const row = findRowByValue_(sheet, "SessionID", sessionId);
          if (!row) return false;
          
          const map = getHeaderMap_(sheet);
          sheet.getRange(row, map["Status"]).setValue("CLOSED");
          sheet.getRange(row, map["UpdatedAt"]).setValue(new Date());
          
          return true;
        });
      }
    },
    
    // ===== CONTACTS =====
    contacts: {
      findOrCreate: function(phone, initialData) {
        const phoneKey = phoneKey_(phone);
        const sheet = getSheet_(LEASING_SHEETS.CONTACTS);
        const map = getHeaderMap_(sheet);
        
        // Find existing
        const lastRow = sheet.getLastRow();
        if (lastRow >= 2) {
          const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
          
          for (let i = 0; i < data.length; i++) {
            const rowPhone = phoneKey_(String(data[i][map["PhoneE164"] - 1] || ""));
            if (rowPhone === phoneKey) {
              const contactId = String(data[i][map["ContactID"] - 1] || "");
              
              // Update LastSeenAt
              withWriteLock_("CONTACT_SEEN", () => {
                sheet.getRange(i + 2, map["LastSeenAt"]).setValue(new Date());
              });
              
              return contactId;
            }
          }
        }
        
        // Create new
        return withWriteLock_("CONTACT_CREATE", () => {
          const contactId = "CONTACT-" + new Date().getTime();
          const now = new Date();
          
          sheet.appendRow([
            contactId,
            phone,
            initialData && initialData.name ? initialData.name : "",
            initialData && initialData.email ? initialData.email : "",
            "en",
            "PROSPECT",
            "PROSPECT",
            now,
            now
          ]);
          
          return contactId;
        });
      },
      
      getById: function(contactId) {
        const sheet = getSheet_(LEASING_SHEETS.CONTACTS);
        const row = findRowByValue_(sheet, "ContactID", contactId);
        if (!row) return null;
        
        const map = getHeaderMap_(sheet);
        const data = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
        
        return {
          contactId: String(data[map["ContactID"] - 1] || ""),
          phone: String(data[map["PhoneE164"] - 1] || ""),
          name: String(data[map["Name"] - 1] || ""),
          email: String(data[map["Email"] - 1] || ""),
          lang: String(data[map["PreferredLang"] - 1] || "en")
        };
      },

      getByPhone: function(phone) {
        const phoneKey = phoneKey_(phone);
        const sheet = getSheet_(LEASING_SHEETS.CONTACTS);
        const map = getHeaderMap_(sheet);

        const lastRow = sheet.getLastRow();
        if (lastRow < 2) return null;

        const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
        for (let i = 0; i < data.length; i++) {
          const rowPhone = phoneKey_(String(data[i][map["PhoneE164"] - 1] || ""));
          if (rowPhone === phoneKey) {
            return {
              contactId: String(data[i][map["ContactID"] - 1] || ""),
              phone: String(data[i][map["PhoneE164"] - 1] || ""),
              name: String(data[i][map["Name"] - 1] || ""),
              email: String(data[i][map["Email"] - 1] || ""),
              lang: String(data[i][map["PreferredLang"] - 1] || "en")
            };
          }
        }
        return null;
      }

    },
    
    // ===== THREADS =====
    threads: {
      findActive: function(contactId) {
        const sheet = getSheet_(LEASING_SHEETS.THREADS);
        const lastRow = sheet.getLastRow();
        if (lastRow < 2) return null;
        
        const map = getHeaderMap_(sheet);
        const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
        const now = Date.now();
        
        for (let i = 0; i < data.length; i++) {
          const rowContact = String(data[i][map["ContactID"] - 1] || "");
          const rowStatus = String(data[i][map["Status"] - 1] || "");
          const expiresAt = data[i][map["ExpiresAt"] - 1];
          
          if (rowContact !== contactId || rowStatus !== "ACTIVE") continue;
          
          // Check expiration
          if (expiresAt && new Date(expiresAt).getTime() < now) {
            continue;
          }
          
          return {
            threadId: String(data[i][map["ThreadID"] - 1] || ""),
            sessionId: String(data[i][map["SessionID"] - 1] || ""),
            unitId: String(data[i][map["UnitID"] - 1] || ""),
            pendingExpected: String(data[i][map["PendingExpected"] - 1] || ""),
            pendingJson: String(data[i][map["PendingJson"] - 1] || "{}")
          };
        }
        
        return null;
      },
      
      create: function(contactId, sessionId, unitId) {
        return withWriteLock_("THREAD_CREATE", () => {
          const sheet = getSheet_(LEASING_SHEETS.THREADS);
          const threadId = "THREAD-" + new Date().getTime();
          const now = new Date();
          const expiresAt = new Date(now.getTime() + LEASING_CONFIG.THREAD_EXPIRE_HOURS * 60 * 60 * 1000);
          
          sheet.appendRow([
            threadId,
            contactId,
            sessionId,
            unitId,
            "",
            LEASING_STAGES.PICK_DAY,
            JSON.stringify({}),
            "ACTIVE",
            expiresAt,
            now,
            now
          ]);
          
          return threadId;
        });
      },
      
      updateStage: function(threadId, stageData) {
        return withWriteLock_("THREAD_UPDATE", () => {
          const sheet = getSheet_(LEASING_SHEETS.THREADS);
          const row = findRowByValue_(sheet, "ThreadID", threadId);
          if (!row) return false;
          
          const map = getHeaderMap_(sheet);
          
          if (stageData.pendingExpected !== undefined) {
            sheet.getRange(row, map["PendingExpected"]).setValue(stageData.pendingExpected);
          }
          
          if (stageData.pendingJson !== undefined) {
            sheet.getRange(row, map["PendingJson"]).setValue(JSON.stringify(stageData.pendingJson));
          }
          
          sheet.getRange(row, map["LastMessageAt"]).setValue(new Date());
          
          return true;
        });
      },
      
      close: function(threadId) {
        return withWriteLock_("THREAD_CLOSE", () => {
          const sheet = getSheet_(LEASING_SHEETS.THREADS);
          const row = findRowByValue_(sheet, "ThreadID", threadId);
          if (!row) return false;
          
          const map = getHeaderMap_(sheet);
          sheet.getRange(row, map["Status"]).setValue("CLOSED");
          sheet.getRange(row, map["PendingExpected"]).setValue("");
          
          return true;
        });
      },
      
      getPendingData: function(threadId) {
        const sheet = getSheet_(LEASING_SHEETS.THREADS);
        const row = findRowByValue_(sheet, "ThreadID", threadId);
        if (!row) return {};
        
        const map = getHeaderMap_(sheet);
        const jsonStr = String(sheet.getRange(row, map["PendingJson"]).getValue() || "{}");
        
        try {
          return JSON.parse(jsonStr);
        } catch (_) {
          return {};
        }
      }
    },
    
    // ===== TOURS =====
    tours: {
      findConflicts: function(unitId, startAt, endAt) {
        const sheet = getSheet_(LEASING_SHEETS.TOURS);
        const lastRow = sheet.getLastRow();
        if (lastRow < 2) return [];
        
        const map = getHeaderMap_(sheet);
        const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
        
        const conflicts = [];
        const newStartMs = new Date(startAt).getTime();
        const newEndMs = new Date(endAt).getTime();
        
        for (let i = 0; i < data.length; i++) {
          const rowUnit = String(data[i][map["UnitID"] - 1] || "");
          const rowStatus = String(data[i][map["Status"] - 1] || "");
          
          if (rowUnit !== unitId) continue;
          if (rowStatus !== "CONFIRMED") continue;
          
          const existingStart = new Date(data[i][map["StartAt"] - 1]).getTime();
          const existingEnd = new Date(data[i][map["EndAt"] - 1]).getTime();
          
          // Check overlap
          if (existingStart < newEndMs && existingEnd > newStartMs) {
            conflicts.push({
              tourId: String(data[i][map["TourID"] - 1] || ""),
              startAt: new Date(existingStart),
              endAt: new Date(existingEnd)
            });
          }
        }
        
        return conflicts;
      },
      
      create: function(tourData) {
        return withWriteLock_("TOUR_CREATE", () => {
          // Final conflict check inside lock
          const conflicts = this.findConflicts(tourData.unitId, tourData.startAt, tourData.endAt);
          
          if (conflicts.length > 0) {
            return {
              success: false,
              reasonKey: "LEASING_TOUR_CONFLICT",
              conflicts: conflicts
            };
          }
          
          const sheet = getSheet_(LEASING_SHEETS.TOURS);
          const tourId = "TOUR-" + new Date().getTime();
          const now = new Date();
          
          sheet.appendRow([
            tourId,
            tourData.sessionId,
            tourData.contactId,
            tourData.unitId,
            tourData.contactPhone,
            tourData.contactName || "",
            tourData.propertyCode,
            tourData.startAt,
            tourData.endAt,
            "CONFIRMED",
            "", // Reminder24hSentAt
            "", // Reminder1hSentAt
            "", // NoShowMarkedAt
            now, // ConfirmedAt
            "", // CompletedAt
            "", // CancelledAt
            now  // CreatedAt
          ]);
          
          // Create WorkItem
          try {
            workItemCreate_({
              type: "LEASING_TOUR",
              status: "OPEN",
              state: "SCHEDULED",
              phoneE164: tourData.contactPhone,
              propertyId: tourData.propertyCode,
              unitId: tourData.unitId,
              metadataJson: JSON.stringify({
                tourId: tourId,
                unitNumber: tourData.unitNumber,
                startAt: tourData.startAt,
                endAt: tourData.endAt
              })
            });
          } catch (err) {
            // WorkItem creation is optional (might not be implemented yet)
            try {
              logDevSms_("(system)", "", "LEASING_WORKITEM_SKIP err=" + String(err.message || err));
            } catch (_) {}
          }
          
          return { success: true, tourId: tourId };
        });
      },
      
      markCompleted: function(tourId) {
        return withWriteLock_("TOUR_COMPLETE", () => {
          const sheet = getSheet_(LEASING_SHEETS.TOURS);
          const row = findRowByValue_(sheet, "TourID", tourId);
          if (!row) return false;
          
          const map = getHeaderMap_(sheet);
          sheet.getRange(row, map["Status"]).setValue("COMPLETED");
          sheet.getRange(row, map["CompletedAt"]).setValue(new Date());
          
          return true;
        });
      },
      
      markNoShow: function(tourId) {
        return withWriteLock_("TOUR_NOSHOW", () => {
          const sheet = getSheet_(LEASING_SHEETS.TOURS);
          const row = findRowByValue_(sheet, "TourID", tourId);
          if (!row) return false;
          
          const map = getHeaderMap_(sheet);
          
          // Only mark if not already marked
          const existing = sheet.getRange(row, map["NoShowMarkedAt"]).getValue();
          if (existing) return false;
          
          sheet.getRange(row, map["Status"]).setValue("NO_SHOW");
          sheet.getRange(row, map["NoShowMarkedAt"]).setValue(new Date());
          
          return true;
        });
      }
    }
  };
}

// ========== LEASING LANE HANDLER ==========

/**
 * Detect leasing intent from message
 */
/**
 * Detect leasing intent from message (keyword-first, Compass-safe)
 * RULES:
 * - Unit numbers NEVER trigger leasing by themselves.
 * - Unit numbers only add confidence if leasing keywords are already present,
 *   or if we are already in a leasing stage/thread.
 */
function detectLeasingIntent_(bodyLower, ctx) {
  const s = String(bodyLower || "").toLowerCase();

  // If we're already inside leasing flow, allow more permissive parsing
  const leasingStage = String((ctx && ctx.leasingPendingExpected) || "");
  const inLeasingThread = leasingStage && leasingStage.indexOf("LEASING_") === 0;

  // Strong leasing keywords (strong-only intent)
  const kwAvailabilityStrong =
    /\b(available|availability|vacanc(y|ies)|vacant|open(ing|ings)?|rent(ing)?|lease|leasing|move[- ]?in|price|pricing|cost|monthly|deposit|application|apply)\b/;
  // Optional "weak nouns" (do NOT trigger leasing by themselves)
  const kwHousingNouns = /\b(units?|apartment(s)?)\b/;
  const kwTour = /\b(tour|view(ing)?|see|visit|show(ing)?)\b/;
  const kwBedBath = /\b(studio|bed(room)?s?|br\b|bath(room)?s?|ba\b)\b/;

  const hasAvailStrong = kwAvailabilityStrong.test(s);
  const hasTour  = kwTour.test(s);

  // "Is apt 303 available?" should count (availability keywords + unit)
  // "apt 303 pennsylvania" alone should NOT.
  const unitNum = (typeof extractUnitNumber_ === "function") ? extractUnitNumber_(s) : "";
  const hasUnit = !!unitNum;

  // Resident phrasing suppression (only when not in leasing thread)
  if (!inLeasingThread) {
    const resident = /\b(i\s+live\s+in|my\s+apartment|my\s+unit|inside\s+my\s+apartment)\b/.test(s);
    if (resident && !hasTour && !hasAvailStrong) return null;
  }

  // Hard decision: must have STRONG leasing intent OR tour OR already in leasing thread
  if (!inLeasingThread && !hasAvailStrong && !hasTour) return null;

  // Determine intent
  if (hasTour) {
    return { intent: "LEASING_TOUR_REQUEST", confidence: hasUnit ? 0.9 : 0.85 };
  }

  // Availability intent
  if (hasAvailStrong) {
    // If they mention unit *and* availability keywords, treat as unit select-ish
    if (hasUnit) return { intent: "LEASING_AVAILABILITY", confidence: 0.92 };
    if (kwBedBath.test(s)) return { intent: "LEASING_AVAILABILITY", confidence: 0.88 };
    return { intent: "LEASING_AVAILABILITY", confidence: 0.85 };
  }

  // Already in leasing thread: allow unit selection as a continuation
  if (inLeasingThread && hasUnit) {
    return { intent: "LEASING_UNIT_SELECT", confidence: 0.8 };
  }

  return null;
}


/**
 * Main leasing lane handler
 */
function handleLeasingLane_(inbound, ctx, intent) {
  const phone = inbound.actorId;
  const bodyTrim = inbound.bodyTrim;
  const bodyLower = inbound.bodyLower;
  
  try {
    logDevSms_(phone, bodyTrim, "LEASING_LANE stage=[" + (ctx.leasingPendingExpected || "NONE") + "]");
  } catch (_) {}
  
  // Get/create contact
  const dal = leasingDal_();
  const contactId = dal.contacts.findOrCreate(phone);
  const contact = dal.contacts.getById(contactId);
  
  // Check for active thread
  let thread = dal.threads.findActive(contactId);
  
  // Parse all possible info from message
  const unitNumber = extractUnitNumber_(bodyTrim);
  const schedule = parseScheduleIntent_(bodyTrim);
  const confirmation = extractConfirmation_(bodyTrim);
  
  // ===== FAST TRACK: Complete info in one message =====
  if (unitNumber && schedule.day && schedule.time && !thread) {
    const unit = dal.units.getById(buildUnitId_(resolvePropertyCode_(bodyTrim, ctx), unitNumber));
    if (unit && (unit.state === OCCUPANCY_STATES.MARKETING || unit.state === OCCUPANCY_STATES.LEASING_ACTIVE)) {
      return handleLeasingFastTrack_({
        unitNumber: unitNumber,
        unitId: unit.unitId,
        day: schedule.day,
        time: schedule.time,
        contactId: contactId,
        contact: contact
      });
    }
  }
  
  // ===== STAGE-BASED FLOW =====
  const stage = (thread && thread.pendingExpected) || "";
  
  if (stage === LEASING_STAGES.PICK_DAY) {
    return handleLeasingPickDay_(thread, schedule.day, bodyTrim, contact);
  }
  
  if (stage === LEASING_STAGES.PICK_TIME) {
    return handleLeasingPickTime_(thread, schedule.time, bodyTrim, contact);
  }
  
  if (stage === LEASING_STAGES.CONFIRM_TOUR) {
    return handleLeasingConfirmTour_(thread, confirmation, bodyTrim, contact);
  }
  
  // ===== ENTRY POINTS (no active thread) =====
  
  if (unitNumber && !thread) {
    // User selected a unit - start thread
    const unit = dal.units.getById(buildUnitId_(resolvePropertyCode_(bodyTrim, ctx), unitNumber));
    
    if (!unit || (unit.state !== OCCUPANCY_STATES.MARKETING && unit.state !== OCCUPANCY_STATES.LEASING_ACTIVE)) {
      return {
        replyKey: "LEASING_UNIT_NOT_AVAILABLE",
        vars: { unitNumber: unitNumber }
      };
    }
    
    // Create session + thread
    const sessionId = dal.sessions.findOrCreate(unit.unitId);
    const threadId = dal.threads.create(contactId, sessionId, unit.unitId);
    
    return {
      replyKey: "LEASING_PICK_DAY",
      vars: {
        unitNumber: unit.unitNumber,
        unitType: unit.unitType,
        rent: unit.rent
      },
      threadId: threadId,
      nextStage: LEASING_STAGES.PICK_DAY
    };
  }
  
  // Default: show availability
  return handleLeasingAvailability_(bodyTrim, contact, ctx);
}

/**
 * Show available units
 */
function handleLeasingAvailability_(bodyTrim, contact, ctx) {
  const dal = leasingDal_();

  const propertyCode = resolvePropertyCode_(bodyTrim, ctx);
  const propertyName = propertyDisplayName_(propertyCode);

  // Phase 1 deterministic filters (safe):
  // - "now"/"today" => AvailableDate <= today (or blank)
  const lower = String(bodyTrim || "").toLowerCase();
  const filters = {
    availableNowOnly: (lower.indexOf("now") !== -1 || lower.indexOf("today") !== -1)
  };

  const units = dal.units.findAvailable(propertyCode, filters);

  if (units.length === 0) {
    return {
      replyKey: "LEASING_NO_UNITS",
      vars: { property: propertyName }
    };
  }

  const unitList = units.slice(0, 5).map(u => {
    const avail = u.availableDate ? formatShortDate_(u.availableDate) : "Now";
    return u.unitNumber + " â€” " + u.unitType + " â€” $" + u.rent + " â€” " + avail;
  }).join("\n");

  return {
    replyKey: "LEASING_AVAILABILITY_RESULTS",
    vars: {
      count: units.length,
      property: propertyName,
      unitList: unitList
    }
  };
}

/**
 * Fast track: complete info provided
 */
function handleLeasingFastTrack_(opts) {
  const dal = leasingDal_();
  const unit = dal.units.getById(opts.unitId);

  // Validate tour hours
  if (!opts.time || !isTimeWithinTourHours_(opts.time.hours, opts.time.minutes)) {
    return {
      replyKey: "LEASING_TIME_OUTSIDE_HOURS",
      vars: { tourHours: tourHoursDisplay_() }
    };
  }
  
  // Build tour time
  const tourStart = new Date(opts.day);
  tourStart.setHours(opts.time.hours, opts.time.minutes, 0, 0);
  
  const tourEnd = new Date(tourStart);
  tourEnd.setMinutes(tourEnd.getMinutes() + LEASING_CONFIG.TOUR_DURATION_MIN);
  
  // Check conflicts
  const conflicts = dal.tours.findConflicts(opts.unitId, tourStart, tourEnd);
  
  if (conflicts.length > 0) {
    const alternatives = findAlternativeTourSlots_(opts.unitId, tourStart);
    return {
      replyKey: "LEASING_TOUR_CONFLICT",
      vars: {
        unitNumber: opts.unitNumber,
        alternatives: formatAlternativeSlots_(alternatives)
      }
    };
  }
  
  // Create session + thread
  const sessionId = dal.sessions.findOrCreate(opts.unitId);
  const threadId = dal.threads.create(opts.contactId, sessionId, opts.unitId);
  
  // Store in thread
  dal.threads.updateStage(threadId, {
    pendingExpected: LEASING_STAGES.CONFIRM_TOUR,
    pendingJson: {
      unitId: opts.unitId,
      unitNumber: opts.unitNumber,
      startAt: tourStart.toISOString(),
      endAt: tourEnd.toISOString()
    }
  });
  
  return {
    replyKey: "LEASING_CONFIRM_TOUR",
    vars: {
      unitNumber: opts.unitNumber,
      unitType: unit.unitType,
      dayTime: formatDayTime_(tourStart),
      property: "The Grand Apartments",
      address: "123 Main St" // TODO: lookup from property
    },
    threadId: threadId,
    nextStage: LEASING_STAGES.CONFIRM_TOUR
  };
}

/**
 * Handle day selection
 */
function handleLeasingPickDay_(thread, parsedDay, bodyTrim, contact) {
  const dal = leasingDal_();
  
  if (!parsedDay) {
    // Couldn't parse - show options
    return {
      replyKey: "LEASING_DAY_NOT_UNDERSTOOD",
      vars: { availableDays: formatNextDays_(3) },
      threadId: thread.threadId,
      nextStage: LEASING_STAGES.PICK_DAY
    };
  }
  
  // Store day, ask for time
  const pending = dal.threads.getPendingData(thread.threadId);
  pending.day = parsedDay.toISOString();
  
  dal.threads.updateStage(thread.threadId, {
    pendingExpected: LEASING_STAGES.PICK_TIME,
    pendingJson: pending
  });
  
  const unit = dal.units.getById(thread.unitId);
  const slots = generateTourSlots_(thread.unitId, parsedDay);
  
  return {
    replyKey: "LEASING_PICK_TIME",
    vars: {
      unitNumber: unit.unitNumber,
      day: formatDayName_(parsedDay),
      timeSlots: formatTimeSlots_(slots)
    },
    threadId: thread.threadId,
    nextStage: LEASING_STAGES.PICK_TIME
  };
}

/**
 * Handle time selection
 */
function handleLeasingPickTime_(thread, parsedTime, bodyTrim, contact) {
  const dal = leasingDal_();
  const pending = dal.threads.getPendingData(thread.threadId) || {};

  // If we somehow lost the day, recover by asking for day again
  if (!pending.day) {
    return {
      replyKey: "LEASING_PICK_DAY",
      vars: {
        unitNumber: (pending.unitNumber || (dal.units.getById(thread.unitId) || {}).unitNumber || "")
      },
      threadId: thread.threadId,
      nextStage: LEASING_STAGES.PICK_DAY
    };
  }

  // If we couldn't parse time, ask again (natural language + fallback list)
  if (!parsedTime) {
    return {
      replyKey: "LEASING_TIME_NOT_UNDERSTOOD",
      vars: { availableTimes: "10:00 AM, 2:00 PM, 4:00 PM" },
      threadId: thread.threadId,
      nextStage: LEASING_STAGES.PICK_TIME
    };
  }

  // Validate tour hours (after we have a time)
  if (!isTimeWithinTourHours_(parsedTime.hours, parsedTime.minutes)) {
    return {
      replyKey: "LEASING_TIME_OUTSIDE_HOURS",
      vars: { tourHours: tourHoursDisplay_() },
      threadId: thread.threadId,
      nextStage: LEASING_STAGES.PICK_TIME
    };
  }

  // Build tour datetime
  const tourStart = new Date(pending.day);
  tourStart.setHours(parsedTime.hours, parsedTime.minutes, 0, 0);

  const tourEnd = new Date(tourStart);
  tourEnd.setMinutes(tourEnd.getMinutes() + LEASING_CONFIG.TOUR_DURATION_MIN);

  // Check conflicts
  const conflicts = dal.tours.findConflicts(thread.unitId, tourStart, tourEnd);

  if (conflicts && conflicts.length > 0) {
    const alternatives = findAlternativeTourSlots_(thread.unitId, tourStart);
    const unitForMsg = dal.units.getById(thread.unitId) || {};
    return {
      replyKey: "LEASING_TOUR_CONFLICT",
      vars: {
        unitNumber: unitForMsg.unitNumber || "",
        alternatives: formatAlternativeSlots_(alternatives)
      },
      threadId: thread.threadId,
      nextStage: LEASING_STAGES.PICK_TIME
    };
  }

  // Store time, ask for confirmation
  pending.startAt = tourStart.toISOString();
  pending.endAt = tourEnd.toISOString();

  dal.threads.updateStage(thread.threadId, {
    pendingExpected: LEASING_STAGES.CONFIRM_TOUR,
    pendingJson: pending
  });

  const unit = dal.units.getById(thread.unitId) || {};

  return {
    replyKey: "LEASING_CONFIRM_TOUR",
    vars: {
      unitNumber: unit.unitNumber || "",
      unitType: unit.unitType || "",
      dayTime: formatDayTime_(tourStart),
      property: "The Grand Apartments",
      address: "123 Main St" // TODO: lookup
    },
    threadId: thread.threadId,
    nextStage: LEASING_STAGES.CONFIRM_TOUR
  };
}

/**
 * Handle tour confirmation
 */
function handleLeasingConfirmTour_(thread, confirmation, bodyTrim, contact) {
  const dal = leasingDal_();
  const pending = dal.threads.getPendingData(thread.threadId) || {};

  if (confirmation === "NO") {
    dal.threads.close(thread.threadId);
    return {
      replyKey: "LEASING_TOUR_CANCELLED",
      vars: {},
      threadId: thread.threadId,
      nextStage: "" // flow ends
    };
  }

  if (confirmation === "YES") {
    const unit = dal.units.getById(thread.unitId) || {};

    // Safety: if pending times are missing, fall back to re-asking time
    if (!pending.startAt || !pending.endAt) {
      return {
        replyKey: "LEASING_TIME_NOT_UNDERSTOOD",
        vars: { availableTimes: "10:00 AM, 2:00 PM, 4:00 PM" },
        threadId: thread.threadId,
        nextStage: LEASING_STAGES.PICK_TIME
      };
    }

    const result = dal.tours.create({
      sessionId: thread.sessionId,
      contactId: thread.contactId,
      unitId: thread.unitId,
      unitNumber: unit.unitNumber,
      contactPhone: contact.phone,
      contactName: contact.name,
      propertyCode: unit.propertyCode,
      startAt: new Date(pending.startAt),
      endAt: new Date(pending.endAt)
    });

    if (!result || !result.success) {
      // Conflict (race condition)
      const alternatives = findAlternativeTourSlots_(thread.unitId, new Date(pending.startAt));
      return {
        replyKey: "LEASING_TOUR_CONFLICT_RACE",
        vars: {
          unitNumber: unit.unitNumber || "",
          alternatives: formatAlternativeSlots_(alternatives)
        },
        threadId: thread.threadId,
        nextStage: LEASING_STAGES.PICK_TIME
      };
    }

    // Success - close thread
    dal.threads.close(thread.threadId);

    return {
      replyKey: "LEASING_TOUR_CONFIRMED",
      vars: {
        unitNumber: unit.unitNumber || "",
        dayTime: formatDayTime_(new Date(pending.startAt)),
        property: "The Grand Apartments",
        address: "123 Main St"
      },
      threadId: thread.threadId,
      nextStage: "" // flow ends
    };
  }

  // Didn't understand confirmation
  return {
    replyKey: "LEASING_CONFIRM_PROMPT",
    vars: {},
    threadId: thread.threadId,
    nextStage: LEASING_STAGES.CONFIRM_TOUR
  };
}


// ========== HELPERS ==========

function buildUnitId_(propertyCode, unitNumber) {
  const pc = String(propertyCode || "").trim().toUpperCase() || LEASING_CONFIG.DEFAULT_PROPERTY_CODE;
  const un = String(unitNumber || "").trim();
  // Keep raw unit number if it already looks padded (e.g., "0305"); otherwise pad to 3
  const norm = un.length >= 3 ? un : un.padStart(3, "0");
  return pc + "_" + norm;
}

function formatShortDate_(date) {
  if (!date) return "Now";
  const d = new Date(date);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months[d.getMonth()] + " " + d.getDate();
}

function formatDayName_(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days[new Date(date).getDay()];
}

function formatDayTime_(date) {
  const d = new Date(date);
  const tz = Session.getScriptTimeZone();
  const day = Utilities.formatDate(d, tz, "EEE, MMM d");
  const time = Utilities.formatDate(d, tz, "h:mm a");
  return day + " at " + time;
}

function formatNextDays_(count) {
  const days = [];
  const now = new Date();
  
  for (let i = 1; i <= count; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    days.push(formatDayName_(d));
  }
  
  return days.join(", ");
}

function generateTourSlots_(unitId, day) {
  // Generate 30-min slots from 9am-6pm
  const slots = [];
  const baseDate = new Date(day);
  
  for (let hour = 9; hour < 18; hour++) {
    for (let min = 0; min < 60; min += 30) {
      const slot = new Date(baseDate);
      slot.setHours(hour, min, 0, 0);
      slots.push(slot);
    }
  }
  
  return slots;
}

function formatTimeSlots_(slots) {
  const tz = Session.getScriptTimeZone();
  return slots.slice(0, 8).map(s => {
    return Utilities.formatDate(s, tz, "h:mm a");
  }).join(", ");
}

function findAlternativeTourSlots_(unitId, desiredStart) {
  const dal = leasingDal_();
  const day = new Date(desiredStart);
  day.setHours(0, 0, 0, 0);
  
  const allSlots = generateTourSlots_(unitId, day);
  const alternatives = [];
  
  for (let i = 0; i < allSlots.length && alternatives.length < 3; i++) {
    const slot = allSlots[i];
    const slotEnd = new Date(slot.getTime() + LEASING_CONFIG.TOUR_DURATION_MIN * 60 * 1000);
    
    const conflicts = dal.tours.findConflicts(unitId, slot, slotEnd);
    if (conflicts.length === 0) {
      alternatives.push(slot);
    }
  }
  
  return alternatives;
}

function formatAlternativeSlots_(slots) {
  if (slots.length === 0) return "No slots available today";
  
  const tz = Session.getScriptTimeZone();
  return slots.map(s => {
    return Utilities.formatDate(s, tz, "h:mm a");
  }).join(", ");
}

// ========== AUTONOMOUS LIFECYCLE JOBS ==========

/**
 * Process leasing lifecycle (runs every 15 min)
 */
function processLeasingLifecycle() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    try {
      logDevSms_("(system)", "", "LEASING_LIFECYCLE_SKIP lock_busy");
    } catch (_) {}
    return;
  }
  
  try {
    processTourReminders_();
    processTourNoShows_();
    ensureMarketingSessions_();
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/**
 * Send tour reminders (idempotent)
 */
function processTourReminders_() {
  try {
    const sheet = getSheet_(LEASING_SHEETS.TOURS);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    
    const map = getHeaderMap_(sheet);
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const now = Date.now();
    
    let sent24h = 0;
    let sent1h = 0;
    
    for (let i = 0; i < data.length; i++) {
      const status = String(data[i][map["Status"] - 1] || "");
      if (status !== "CONFIRMED") continue;
      
      const startAt = new Date(data[i][map["StartAt"] - 1]).getTime();
      const reminder24h = data[i][map["Reminder24hSentAt"] - 1];
      const reminder1h = data[i][map["Reminder1hSentAt"] - 1];
      
      // 24h reminder
      if (!reminder24h) {
        const hoursUntil = (startAt - now) / (60 * 60 * 1000);
        if (hoursUntil <= 24 && hoursUntil > 0) {
          const phone = String(data[i][map["ContactPhone"] - 1] || "");
          const unitId = String(data[i][map["UnitID"] - 1] || "");
          const unit = leasingDal_().units.getById(unitId);
          
          if (phone && unit) {
            sendLeasingReminder_(phone, unit, new Date(startAt), "24h");
            
            withWriteLock_("LEASING_REMINDER_24H", () => {
              sheet.getRange(i + 2, map["Reminder24hSentAt"]).setValue(new Date());
            });
            
            sent24h++;
          }
        }
      }
      
      // 1h reminder
      if (!reminder1h) {
        const hoursUntil = (startAt - now) / (60 * 60 * 1000);
        if (hoursUntil <= 1 && hoursUntil > 0) {
          const phone = String(data[i][map["ContactPhone"] - 1] || "");
          const unitId = String(data[i][map["UnitID"] - 1] || "");
          const unit = leasingDal_().units.getById(unitId);
          
          if (phone && unit) {
            sendLeasingReminder_(phone, unit, new Date(startAt), "1h");
            
            withWriteLock_("LEASING_REMINDER_1H", () => {
              sheet.getRange(i + 2, map["Reminder1hSentAt"]).setValue(new Date());
            });
            
            sent1h++;
          }
        }
      }
    }
    
    if (sent24h > 0 || sent1h > 0) {
      try {
        logDevSms_("(system)", "", "LEASING_REMINDERS sent_24h=" + sent24h + " sent_1h=" + sent1h);
      } catch (_) {}
    }
  } catch (err) {
    try {
      logDevSms_("(system)", "", "LEASING_REMINDERS_ERR " + String(err.message || err));
    } catch (_) {}
  }
}

/**
 * Mark no-shows (idempotent)
 */
function processTourNoShows_() {
  try {
    const sheet = getSheet_(LEASING_SHEETS.TOURS);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    
    const map = getHeaderMap_(sheet);
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const now = Date.now();
    
    let marked = 0;
    
    for (let i = 0; i < data.length; i++) {
      const status = String(data[i][map["Status"] - 1] || "");
      if (status !== "CONFIRMED") continue;
      
      const startAt = new Date(data[i][map["StartAt"] - 1]).getTime();
      const noShowMarked = data[i][map["NoShowMarkedAt"] - 1];
      
      // 90 min after start time
      if (!noShowMarked && now > startAt + (90 * 60 * 1000)) {
        const tourId = String(data[i][map["TourID"] - 1] || "");
        
        leasingDal_().tours.markNoShow(tourId);
        
        // Optional: send follow-up
        const phone = String(data[i][map["ContactPhone"] - 1] || "");
        if (phone) {
          sendLeasingNoShowFollowup_(phone);
        }
        
        marked++;
      }
    }
    
    if (marked > 0) {
      try {
        logDevSms_("(system)", "", "LEASING_NOSHOWS marked=" + marked);
      } catch (_) {}
    }
  } catch (err) {
    try {
      logDevSms_("(system)", "", "LEASING_NOSHOWS_ERR " + String(err.message || err));
    } catch (_) {}
  }
}

/**
 * Ensure marketing units have open sessions
 */
function ensureMarketingSessions_() {
  try {
    const sheet = getSheet_(LEASING_SHEETS.UNITS);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    
    const map = getHeaderMap_(sheet);
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    
    let created = 0;
    
    for (let i = 0; i < data.length; i++) {
      const state = String(data[i][map["OccupancyState"] - 1] || "");
      const sessionId = String(data[i][map["LeasingSessionID"] - 1] || "");
      
      if ((state === OCCUPANCY_STATES.MARKETING || state === OCCUPANCY_STATES.LEASING_ACTIVE) && !sessionId) {
        const unitId = String(data[i][map["UnitID"] - 1] || "");
        
        const newSessionId = leasingDal_().sessions.findOrCreate(unitId);
        created++;
        
        try {
          logDevSms_("(system)", "", "LEASING_SESSION_AUTO unit=" + unitId + " session=" + newSessionId);
        } catch (_) {}
      }
    }
    
    if (created > 0) {
      try {
        logDevSms_("(system)", "", "LEASING_SESSIONS_ENSURED created=" + created);
      } catch (_) {}
    }
  } catch (err) {
    try {
      logDevSms_("(system)", "", "LEASING_SESSIONS_ERR " + String(err.message || err));
    } catch (_) {}
  }
}

/**
 * Send tour reminder (via central template system)
 */
function sendLeasingKey_(phone, replyKey, vars, tag) {
  // Phase 1: resolve language from Contacts; fallback to "en"
  let lang = "en";
  try {
    const c = leasingDal_().contacts.getByPhone(phone);
    if (c && c.lang) lang = String(c.lang || "en");
  } catch (_) {}

  try {
    const msg = renderTenantKey_(replyKey, lang, vars || {});
    sendRouterSms_(phone, msg, tag || "LEASING");
  } catch (err) {
    try { logDevSms_("(system)", "", "LEASING_SEND_ERR tag=" + String(tag || "") + " key=" + String(replyKey || "") + " err=" + String(err.message || err)); } catch (_) {}
  }
}

function sendLeasingReminder_(phone, unit, tourStart, timing) {
  const vars = {
    unitNumber: unit.unitNumber,
    dayTime: formatDayTime_(tourStart),
    property: "The Grand Apartments",
    address: "123 Main St"
  };

  const replyKey = timing === "24h" ? "LEASING_TOUR_REMINDER_24H" : "LEASING_TOUR_REMINDER_1H";
  sendLeasingKey_(phone, replyKey, vars, "LEASING_REMINDER");
}

/**
 * Send no-show follow-up
 */
function sendLeasingNoShowFollowup_(phone) {
  sendLeasingKey_(phone, "LEASING_TOUR_NO_SHOW_FOLLOWUP", {}, "LEASING_NOSHOW_FOLLOWUP");
}

// ========== MANAGER COMMANDS (Optional) ==========

/**
 * Parse manager command
 * Examples: "set 305 marketing", "set 305 ready"
 */
function parseManagerLeasingCommand_(bodyTrim) {
  const txt = String(bodyTrim || "").trim();
  const lower = txt.toLowerCase();

  // Supports:
  //  - "set 305 marketing"
  //  - "set penn 305 marketing"
  const setMatch = lower.match(/\bset\s+(?:([a-z]{3,10})\s+)?(\d{3,4})\s+(ready|marketing|leasing|committed|occupied)\b/);
  if (setMatch) {
    const maybeProp = String(setMatch[1] || "").toUpperCase().trim();
    const prop = maybeProp ? extractPropertyCode_(maybeProp) || maybeProp : "";
    return {
      type: "SET_UNIT_STATE",
      propertyCode: prop,
      unitNumber: setMatch[2],
      rawState: String(setMatch[3] || "").toLowerCase()
    };
  }

  return null;
}

/**
 * Handle manager command (call from router if manager phone detected)
 */
function handleManagerLeasingCommand_(phone, bodyTrim) {
  const cmd = parseManagerLeasingCommand_(bodyTrim);

  if (!cmd) return null;

  if (cmd.type === "SET_UNIT_STATE") {
    const pc = cmd.propertyCode || LEASING_CONFIG.DEFAULT_PROPERTY_CODE;

    // Map friendly words to canonical occupancy states
    let state = "";
    const rs = String(cmd.rawState || "").toLowerCase();
    if (rs === "ready") state = OCCUPANCY_STATES.READY;
    else if (rs === "marketing") state = OCCUPANCY_STATES.MARKETING;
    else if (rs === "leasing") state = OCCUPANCY_STATES.LEASING_ACTIVE;
    else if (rs === "committed") state = OCCUPANCY_STATES.COMMITTED;
    else if (rs === "occupied") state = OCCUPANCY_STATES.OCCUPIED;

    if (!state) return null;

    const unitId = buildUnitId_(pc, cmd.unitNumber);
    const success = leasingDal_().units.updateState(unitId, state);

    if (success) {
      // If setting to MARKETING/LEASING_ACTIVE, ensure session exists
      if (state === OCCUPANCY_STATES.MARKETING || state === OCCUPANCY_STATES.LEASING_ACTIVE) {
        leasingDal_().sessions.findOrCreate(unitId);
      }

      return {
        replyKey: "LEASING_UNIT_STATE_UPDATED",
        vars: { unitNumber: cmd.unitNumber, state: state }
      };
    }
  }

  return null;
}
