# Outgate Plan — Alignment with Signal Architecture

**Question:** Is the Outgate execution plan in line with [PROPERA_SIGNAL_ARCHITECTURE.md](PROPERA_SIGNAL_ARCHITECTURE.md)?

**Answer: Yes.** The plan implements the “Canonical Outbound Intent → Outgate → carriers” leg without changing adapters, compiler, or domain engine logic.

---

## Signal Architecture (summary)

- **Flow:** Adapter → Canonical Signal Package → Signal Layer → Compiler → Context Accumulation → Domain Router → **Domain Engines** → **Canonical Outbound Intent** → **Outgate** → SMS/WA/Alexa/Portal/Push
- **Rules:** Adapters transport only; shared front no channel-specific logic; domain engines own business logic; **Outgate receives Canonical Outbound Intent from the engines, chooses carrier, uses existing send functions; no adapter-specific send logic.**
- **Tagline:** “Package in, package out. The adapter leaves the package at the door; the brain opens it; outgate delivers the result.”

---

## How the Outgate plan matches

| Signal Architecture | Outgate plan |
|---------------------|--------------|
| **Canonical Outbound Intent** from engines | V1 intent contract (intentType, templateKey, recipientType, recipientRef, channel, deliveryPolicy, vars) is the concrete shape. Call sites live in domain flow (e.g. handleSmsCore_); they emit the intent; they do not open the inbound package or add adapter logic. |
| **Outgate receives** intent from engines | All migrated paths call `dispatchOutboundIntent_(intent)`; no direct `reply_()` for those paths. Outgate is the single consumer of the intent. |
| **Outgate chooses carrier** (SMS, WA, Alexa, …) | Intent carries `channel` (from request context for same-turn reply). Outgate uses it for render (SMS vs WA rules) and for delivery (which carrier). So Outgate chooses carrier from intent + existing send stack. |
| **Uses existing send functions; no adapter-specific send logic** | Delivery remains `sendRouterSms_` / `sendSms_` / `sendWhatsApp_`; no new transport or adapter code. Channel only selects which existing path to use. |
| **Adapters transport only** | No change to inbound adapters; they still produce the canonical signal package. The plan only changes how the **outbound** leg is invoked (intent → Outgate instead of direct `reply_()`). |
| **Domain engines same behavior regardless of inbound channel** | The plan does not change `compileTurn_`, `resolveEffectiveTicketState_`, `finalizeDraftAndCreateTicket_`. Domain logic stays channel-agnostic; only the expression/delivery boundary (Outgate) is channel-aware. |

---

## Conclusion

The Outgate plan is **in line** with the Signal Architecture. It extends the existing Outgate path so that domain engines emit a **Canonical Outbound Intent** and **Outgate** owns rendering and carrier choice using the current send stack. Add a reference to [PROPERA_SIGNAL_ARCHITECTURE.md](PROPERA_SIGNAL_ARCHITECTURE.md) in the execution plan’s References if you want the link in one place.
