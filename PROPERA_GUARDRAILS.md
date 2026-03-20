# PROPERA_GUARDRAILS.md
> Implementation Guardrails for AI and Contributors
> If a change conflicts with these guardrails, the change is wrong even if it "works."

---

## Purpose

This file defines the non-negotiable implementation rules for Propera.

All code changes must preserve:
- deterministic operational behavior
- responsibility-aware routing
- lifecycle integrity
- auditability
- architectural layering (Signal → Brain → Outgate)
- evolution toward the Propera North Compass

---

## 0. System Shape (Non-Negotiable Architecture)

All flows must respect this structure:

```
INBOUND
→ Adapter (transport only)
→ Signal Layer (normalize)
→ Compiler / Context Layer
→ Responsibility Resolver
→ Domain Engine (Lifecycle / Policy)
→ Canonical Outbound Intent
→ Outgate (channel + expression)
```

- No code may skip layers.
- Adapters do not decide.
- Outgate does not decide.
- AI does not decide.
- The Brain (resolver + lifecycle + policy) decides.

---

## 1. Do not let AI become the operating system

AI must **never** be the source of truth for:
- responsibility assignment
- lifecycle state
- escalation decisions
- ownership changes
- schedule truth
- policy truth
- completion truth

AI **may** assist with:
- interpretation of messy inputs
- extraction of structured data
- summarization
- message expression (Outgate layer)

The engine decides what is true. AI only helps interpret or express that truth.

---

## 2. All inbound reality must become a normalized signal

Every input must enter through the Signal Layer:
- tenant SMS / WhatsApp / Telegram
- staff commands (`#capture`, natural language)
- voice / Alexa / future devices
- owner communication
- vendor communication
- IoT events
- timer callbacks
- portal submissions
- external API webhooks

All must produce a **Canonical Signal Package**.

No workflow should bypass normalization.
No business logic should act on raw transport payloads.

---

## 3. Adapters are transport-only

Adapters **may**:
- authenticate
- normalize transport payload shape
- attach channel metadata
- acknowledge receipt
- hand off canonical signal packages to the shared front door

Adapters **must not**:
- parse operational intent
- assign responsibility
- mutate lifecycle state
- apply business policy
- send operational decisions
- contain channel-specific business workflows

> Adapter = package in, package out.

---

## 4. Context must be extracted before action

Signals are not actions. Signals must first become operational context.

Context extraction must produce, where applicable:
- actor
- channel
- property
- unit
- domain
- issue summary
- severity hint
- lifecycle relevance
- scheduling data
- referenced work item / ticket context

No domain engine should act on ambiguous raw input when structured context has not been resolved enough to make the next step explicit.

---

## 5. Responsibility must be resolved explicitly

No feature code should hardcode routing.

Responsibility must always flow through:
- identity resolution
- assignment data
- routing rules
- resolver logic
- lifecycle context

Always ask: **Who owns the next action?**

If the answer is hidden in feature code, the implementation is wrong.

---

## 6. Lifecycle is the single source of operational truth

All operational state must live in the lifecycle model.

State changes must be:
- explicit
- explainable
- logged
- policy-driven
- consistent with current lifecycle state

**Forbidden:**
- silent state mutation
- bypassing lifecycle transitions
- patching truth through ad hoc sheet edits
- hidden writes that alter operational meaning without auditability

---

## 7. Lifecycle engine must remain domain-pure

Lifecycle **must not** contain:
- channel logic (SMS, Telegram, WhatsApp, Alexa, Portal, etc.)
- transport-specific response handling
- free-text parsing logic
- identity guessing
- staff command parsing
- adapter behavior

Lifecycle **may**:
- evaluate current state
- apply policy
- determine next action
- set timers
- emit canonical lifecycle decisions
- request outbound intents

Lifecycle decides domain progression, not transport behavior.

---

## 8. One system, not parallel systems

If a feature needs routing, timers, escalation, responsibility, messaging, logging, or lifecycle control — **extend the existing mechanism**.

Do not create:
- a second resolver
- a second lifecycle model
- a second timer engine
- a second audit trail
- a second messaging path for the same concept
- parallel state hidden in convenience helpers

Parallel systems create silent drift.

---

## 9. Reuse canonical write paths

Before adding a new write path, check whether a canonical helper already exists.

Canonical helpers include:
- `workItemCreate_()`
- `wiTransition_()`
- `workItemUpdate_()`
- `policyLogEventRow_()`
- `withWriteLock_()`
- `dalWithLock_()`
- property normalization helpers
- identity resolution helpers
- canonical outbound intent + Outgate paths

> One concept. One primary write path.

---

## 10. All operational writes must be lock-safe

Any mutation of operational truth must use the project's lock discipline.

This includes:
- work items
- lifecycle state
- conversation context
- timers
- assignments
- policy logs
- routing tables
- sheet structure that affects runtime behavior

Prefer:
- `withWriteLock_()`
- `dalWithLock_()`

Do not introduce unlocked writes for important state.

---

## 11. Everything important must be auditable

The system must log enough to reconstruct:
- what signal arrived
- how it was normalized
- what context was extracted
- what resolver path was used
- who was assigned responsibility
- what lifecycle transition occurred
- what outbound intent was emitted
- what actual communication was sent
- what timer or escalation was scheduled
- why a branch was taken

If a behavior cannot be explained later, it is not production-safe.

---

## 12. Outbound must go through canonical intent → Outgate

No domain code should send operational messages directly.

Correct flow:
```
decision → canonical outbound intent → Outgate → channel
```

Outgate is responsible for:
- channel selection
- formatting
- compliance wrappers
- transport-specific delivery behavior
- expression rendering
- future AI-assisted phrasing under policy constraints

Outgate must not redefine business truth.

---

## 13. Do not hardcode people, properties, or roles

**Forbidden:**
```javascript
if (staffName === "Nick") { ... }
if (property === "PENN") { ... }
if (owner === "John") { ... }
if (building === "MURR") { sendTo("+1..."); }
```

All human or building targeting must come from:
- resolver output
- assignments
- routing rules
- policy
- normalized data

People and buildings are data, not code.

---

## 14. Do not over-template communication

Templates are acceptable for:
- compliance
- legal / safety language
- short acknowledgments
- fallback messaging
- bounded deterministic fragments

Propera's long-term communication model is:
1. Deterministic engine chooses message intent
2. Outgate / expression layer renders role-appropriate message
3. Policy constraints limit what may be said
4. Channel requirements shape final output

Do not build massive template trees as a substitute for proper intent architecture.

---

## 15. Preserve strict separation of layers

| Layer | Responsibility |
|---|---|
| Adapter | Receive / authenticate / normalize transport payload |
| Signal Layer | Produce canonical signal package |
| Compiler / Context Layer | Extract operational meaning |
| Responsibility Resolver | Determine who owns next action |
| Domain Engine / Lifecycle / Policy | Decide what should happen next |
| Canonical Outbound Intent | Represent the decision in transport-neutral form |
| Outgate | Deliver and express the decision per channel |

Do not collapse multiple layers into one convenience function.
Do not let transport, interpretation, responsibility, lifecycle, and expression blur together.

---

## 16. Build the smallest live loop first

When implementing new architecture or new capability:
1. choose one narrow live path
2. prove it end to end
3. verify truth, auditability, and ownership behavior
4. then generalize

Good rollout examples:
- maintenance request → responsibility assigned
- overdue ticket → ask responsible staff for update
- vendor needed → vendor branch created
- portal/staff free text → shared scheduling parser → canonical schedule object

Avoid solving every domain and every channel at once.

---

## 17. Routing must be role-aware, not staffing-assumption based

The system must support:
- one person holding multiple roles
- different staffing models by building
- owner-involved and owner-non-involved operations
- PM / super overlap in small buildings
- dedicated staff in larger operations
- vendor involvement only when needed

Routing must always be context-based and role-aware.
Do not assume one staffing shape.

---

## 18. Vendor is a branch, not the trunk

Property operations are generally:
- in-house first
- PM / super / maintenance centered
- vendor only when required by policy, skill, availability, or escalation

Vendor workflows are supported branches of lifecycle, not the default mental model.

Do not design vendor-first systems unless policy explicitly requires it.

---

## 19. All inputs and outputs must converge on shared cores

New inputs (voice, Alexa, WhatsApp, Telegram, portal, screenshots, IoT, external APIs) must follow the same core path:

```
signal → context → resolver → lifecycle → intent → outgate
```

Outputs must converge through shared Outgate delivery decisions rather than channel-specific business branches.

No special-case bypass flows for machine-originated or premium-channel signals.

---

## 20. Shared parsers should become shared infrastructure

If multiple channels or entry points need the same interpretation capability, it becomes shared infrastructure — not duplicated logic.

Examples:
- schedule parsing
- property normalization
- unit extraction
- issue summarization
- staff command resolution
- referenced ticket/work item resolution

Do not keep channel-specific clones of the same parser when the logic represents shared operational meaning.

---

## 21. Optimize for operational truth, not demo polish

A feature is **successful** when:
- the right person is informed
- the right next action is known
- the lifecycle moves correctly
- the audit trail is intact
- the state is inspectable and replayable

A feature is **not** successful merely because:
- the message sounds polished
- the demo looks smooth
- the flow seems clever
- the UI hides the underlying ambiguity

> A polished message with wrong operational behavior is failure. Truth first. Fluency second.

---

## 22. Make everything explicit

Prefer:
- explicit states
- explicit ownership
- explicit timers
- explicit schedule objects
- explicit transition reasons
- explicit event logs
- explicit canonical intents

Avoid:
- hidden inference
- magical coupling
- state implied only by message text
- behavior that depends on invisible memory
- transport-specific side effects that change truth indirectly

Explicit systems scale better.

---

## 23. System safety is mandatory

All production-safe flows must include, where applicable:
- deduplication (SID / fingerprint / replay guards)
- lock protection around operational writes
- failure-safe fallback response behavior
- structured error logging
- safe retries or idempotent handling
- crash containment
- deterministic handling of fragmented or repeated signals

The system must fail safely, not mysteriously.

---

## 24. Ship-first architecture, but never at the cost of truth

Propera may ship on Sheets / Apps Script / lightweight infrastructure for speed, but every meaningful feature must still respect:
- unified routing
- explicit state
- canonical write paths
- structured auditability
- future migration readiness

Fast implementation is acceptable. Architectural debt disguised as speed is not.

---

## 25. Jarvis is interface, not authority

Future conversational or voice AI may sound like Jarvis, but it must remain:
- interface
- translator
- explainer
- guide
- expression layer

Jarvis must **never** become:
- source of operational truth
- authority on ownership
- lifecycle controller
- policy engine
- hidden resolver

The orchestration engine remains the authority.

---

## Review Checklist for Every Meaningful Change

Before approving any meaningful change, ask:

- [ ] Does it follow Signal → Brain → Outgate?
- [ ] Does it preserve deterministic operational truth?
- [ ] Does it normalize inbound reality into a canonical signal?
- [ ] Does it extract context before acting?
- [ ] Does it route through the resolver where appropriate?
- [ ] Does it keep lifecycle changes explicit and logged?
- [ ] Does it keep lifecycle domain-pure?
- [ ] Does it reuse canonical write and log paths?
- [ ] Is every important action auditable?
- [ ] Does outbound flow through canonical intent → Outgate?
- [ ] Does it avoid hardcoded person/building logic?
- [ ] Does it avoid creating a parallel system?
- [ ] Does it keep adapters transport-only?
- [ ] Does it keep AI in an assistive, non-authoritative role?
- [ ] Is it safe under duplicate, replayed, or concurrent inputs?

**If any answer is "no" — revise the change.**
