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
- modular evolution toward the Propera North Compass

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
- expression / communication generation
- summarization

> The engine decides what is true. AI only helps interpret or express that truth.

---

## 2. All inbound reality must become a normalized signal

Every input must enter through the Signal Layer:
- tenant SMS
- staff SMS
- owner request
- vendor reply
- IoT event
- timer callback
- portal submission
- external API webhook

No workflow should bypass normalization.
Every signal must be converted into structured context before business logic acts on it.

---

## 3. Responsibility must be resolved explicitly

No code should hardcode ad hoc person routing when the resolver can determine it.

The system routes through:
- staff/contact identity
- staff assignments
- routing rules
- responsibility resolver

Always ask: **Who owns the next action in this context?**

Do not embed hidden routing assumptions in feature code.

---

## 4. Lifecycle changes must go through the operational model

State changes must be:
- intentional
- explainable
- logged
- consistent with current lifecycle

**Avoid:**
- random direct sheet mutations
- "quick fixes" that silently patch status
- hidden writes that do not update the audit trail

---

## 5. Reuse canonical write paths

Before adding a new write path, check whether a canonical helper already exists.

Canonical helpers:
- `workItemCreate_()` — work item creation + ownership fields
- `wiTransition_()` — work item state transitions
- `workItemUpdate_()` — work item field patches
- `policyLogEventRow_()` — all policy/assignment audit logging
- `getOrCreateSheet_()` — sheet bootstrap
- `withWriteLock_()` / `dalWithLock_()` — lock discipline
- `getActiveProperties_()` / `getPropertyIdByCode_()` / `getPropertyByNameOrCode_()` — property normalization
- `renderTenantKey_()` + `sendRouterSms_()` — all outbound tenant SMS

> One concept. One primary write path.

---

## 6. All writes that affect operational truth must be lock-safe

Any code that mutates:
- tickets
- work items
- conversation state
- timers
- policy logs
- assignments
- sheet structure

must use the project's lock discipline.

**Prefer:** `withWriteLock_()` or `dalWithLock_()`

Do not introduce unlocked writes for important state.

---

## 7. All important actions must be auditable

The system must log enough to reconstruct:
- what signal arrived
- what context was extracted
- what rule/path was selected
- who was assigned responsibility
- what message/action was sent
- what escalations happened

If a new behavior cannot be explained later, it is not production-safe.

**Reuse:**
- `PolicyEventLog`
- existing operational logs
- existing debug logs (`logDevSms_()`)

---

## 8. Do not hardcode role/person logic into domain flows

**Avoid:**
```javascript
if (staffName === "Nick") { ... }
if (building === "PENN") { sendTo("+1..."); }
if (owner === "John") { ... }
```

All human targeting must come from:
- resolver output
- assignments
- routing rules
- policy

> People are data, not code.

---

## 9. Do not over-template human communication

Templates are acceptable for:
- compliance
- legal/safety keywords
- short standard acknowledgments
- fallback messages

Propera's long-term communication model:
1. Deterministic engine chooses **message intent**
2. AI expression layer generates **role-appropriate message**
3. Hard policy constraints limit what can be said

Do not try to model all operational communication with massive template trees.

---

## 10. Preserve separation of concerns

Keep these layers distinct and do not collapse them into one function:

| Layer | Responsibility |
|---|---|
| Signal Layer | Where inputs arrive from |
| Context Layer | What the signal means |
| Responsibility Resolver | Who owns the next action |
| Policy / Lifecycle Layer | What should happen next |
| Communication Layer | Who needs to be informed |
| Expression Layer | How the message is phrased |

---

## 11. Prefer extension over parallel systems

If a feature needs routing, timers, escalation, responsibility, messaging, or logging — **extend the existing mechanism**.

Do not create:
- a second resolver
- a second timer engine
- a second audit trail
- a second lifecycle model

> Parallel systems create hidden drift.

---

## 12. Build the smallest live loop first

When implementing new architecture:
1. Choose one narrow live path
2. Prove it end to end
3. Then generalize

**Good rollout examples:**
- maintenance request → responsibility assigned
- overdue ticket → ask responsible staff for update
- vendor needed → vendor branch created

Avoid solving every domain at once.

---

## 13. Property operations are role-aware, not person-assumption based

The system must support:
- one person holding multiple roles
- different buildings with different staffing models
- owners with different involvement levels
- PM/super overlap in small operations
- dedicated staff in larger operations

Routing must be context-based and role-aware. Do not assume one staffing shape.

---

## 14. Vendor is a branch, not the trunk

Real property operations are:
- **in-house first**
- PM/super/maintenance-centered
- vendor only when needed

Vendor workflows are a supported branch of the lifecycle, not the default mental model.

---

## 15. IoT and external APIs must plug into the same core

New inputs — leak sensors, access systems, noise detectors, external APIs — must follow the same pattern:

```
signal → context → responsibility → policy → lifecycle → communication
```

Do not build special-case bypass flows for machine-originated signals.

---

## 16. Optimize for operational truth, not demo polish

A feature is successful when:
- the right person is informed
- the right next action is known
- the lifecycle moves correctly
- the audit trail is intact

> A polished message with wrong operational behavior is failure.
> Truth first. Fluency second.

---

## 17. When in doubt, make the system more explicit

**Prefer:**
- explicit states
- explicit assignments
- explicit timers
- explicit reasons
- explicit event logs

**Avoid:**
- hidden inference
- magical coupling
- state implied only by message text
- behavior that depends on memory no one can inspect

Explicit systems scale better.

---

## 18. Jarvis is interface, not authority

Future conversational/voice AI may sound like Jarvis, but it must remain:
- interface
- translator
- explainer
- guide

Jarvis is not the authority on building operations.
**The orchestration engine remains the authority.**

---

## Review Checklist for Every Meaningful Change

Before approving any change, ask:

- [ ] Does this preserve deterministic operational truth?
- [ ] Does this route through the resolver where appropriate?
- [ ] Does it keep lifecycle changes explicit?
- [ ] Does it reuse canonical write/log paths?
- [ ] Is it auditable?
- [ ] Does it fit the North Compass?
- [ ] Does it avoid creating a parallel system?

**If any answer is "no" — revise the change.**

---

## One Sentence Reminder

> Do not build clever automations. Build a trustworthy operational brain.
