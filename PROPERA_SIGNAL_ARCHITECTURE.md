# Propera Signal Architecture — North Star

**Do not drift.** All channels and domains flow through this pipeline. Adapters are transport-only; domain engines and outgate own behavior.

---

## Flow

```
INBOUND
  Any channel → Adapter → Canonical Signal Package
                                ↓
SHARED FRONT
       Signal Layer → Compiler → Context Accumulation
                                ↓
                          Domain Router
                                ↓
DOMAIN ENGINES
       Maintenance Engine
       Amenity Engine
       Cleaning Engine
       Conflict Engine
       Leasing Engine
       Finance Engine
                                ↓
SHARED BACK
                Canonical Outbound Intent
                                ↓
                             Outgate
                                ↓
       SMS / WhatsApp / Alexa / Portal / Push
```

---

## Rules

- **Adapters:** Transport only. Normalize input into a **Canonical Signal Package**. Authenticate, acknowledge receipt. Do **not** open the package, interpret it, or decide outbound messages.
- **Shared front:** One compiler, one context accumulation, one domain router. No channel-specific logic here.
- **Domain engines:** Own all business logic for their domain. Same behavior regardless of inbound channel.
- **Outgate:** Receives **Canonical Outbound Intent** from the engines. Chooses **carrier** (SMS, WA, Alexa, Portal, Push). Uses existing send functions; no adapter-specific send logic.

**Package in, package out.** The adapter leaves the package at the door; the brain opens it; outgate delivers the result.
