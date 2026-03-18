# Propera North Compass

**Architecture Doctrine for AI and Contributors**

---

## Mission

Propera is a **responsibility-aware orchestration engine** for property operations.

Its job is not simply to record events or dispatch vendors.  
Its job is to **coordinate signals, roles, and lifecycle actions** so buildings run smoothly while the correct humans remain in the loop.

The system must always answer:

**Given this signal, who owns the next action?**

Everything in Propera exists to support that question.

---

## Core Philosophy

### 1. Signals are the entry point

Everything that happens in a property is treated as a **signal**.

Examples:

- tenant SMS
- staff updates
- owner requests
- vendor confirmations
- IoT sensor events
- portal submissions
- scheduled timers
- external APIs

Signals are not actions. Signals must be **interpreted** before the system reacts.

### 2. Context must be extracted before action

Every signal must be converted into **operational context**:

Context includes: property, unit, domain, severity, lifecycle stage, responsible role, source.

This interpretation layer is **deterministic**. AI may assist extraction, but the system must not rely on hallucinated meaning.

### 3. Responsibility is the system's central function

Propera is built around **responsibility resolution**.

The system must determine:

- who owns the next action
- who stays informed
- who is escalation
- what policy governs the action

This is implemented through: Staff directory, Staff assignments, Routing rules, Resolver logic.

**The resolver is the operational brain.**

### 4. Lifecycle orchestration moves work forward

Once responsibility is known, Propera manages the **lifecycle**.

Examples:

- **Maintenance lifecycle:** intake → assignment → scheduling → access coordination → status updates → completion confirmation → escalation if needed
- **Rules lifecycle:** initial outreach → enforcement escalation → administrative branch
- **Preventive lifecycle:** campaign scheduling → work batching → staff routing

The system should move work forward automatically whenever possible.

### 5. Humans remain decision makers

Propera is autonomous in **coordination**, not **authority**.

The system must not remove human judgment. Examples: vendors are dispatched by PM decision; owners approve financial decisions; supers confirm work completion.

Propera reduces friction by: tracking responsibility, coordinating communication, reminding the correct person, maintaining operational memory.

### 6. AI is an expression layer, not a control layer

**AI should never decide operational truth.**

Operational decisions must come from: policy, resolver, lifecycle engine.

AI is used to: interpret messy input, generate contextual communication, summarize operational state.

**The engine decides what to do. AI decides how to say it.**

### 7. Deterministic core, adaptive edges

The system must be structured as:

- **Deterministic core:** resolver, policy engine, lifecycle engine, state transitions
- **Adaptive edges:** language understanding, message generation, summarization

This separation protects reliability.

---

## Architectural Layers

The system should evolve toward the following structure:

```
Signal Layer          (SMS, IoT, APIs, timers)
        ↓
Context Engine        (extract property/domain/state)
        ↓
Responsibility Resolver  (resolveResponsibleParty)
        ↓
Policy Engine         (rules, escalation, timers)
        ↓
Lifecycle Orchestration  (ticket state machine)
        ↓
Communication Layer   (notifications, coordination)
        ↓
Expression Agent      (AI-generated messaging)
        ↓
Operational Memory    (audit + history)
```

---

## System Behavior Principles

- **Always deterministic first** — If a deterministic rule can solve the problem, use it. AI is a fallback, not a primary decision engine.
- **Never bypass the lifecycle** — All operational actions must pass through the lifecycle engine. No direct side-channel updates.
- **All actions must be auditable** — Every assignment, escalation, and lifecycle change must be logged. The system must always be able to answer: what happened, why it happened, who was responsible, what the system did.
- **Keep humans in the loop** — Even when the system acts autonomously, it must maintain visibility for the correct role (tenant, staff, PM, owner). The correct audience must always understand the current situation.

---

## Long-Term Vision

Propera will evolve into a **Property Operations OS**.

Capabilities will expand to include: preventive maintenance orchestration, staff scheduling optimization, IoT event coordination, access automation, vendor coordination, operational analytics, AI conversational interface.

Eventually, a **Jarvis-style interface** will sit on top of the system.  
**Jarvis is the personality. Propera's orchestration engine remains the brain.**

---

## Development Rules for AI Assistants

When modifying the codebase:

- Do not bypass the resolver.
- Do not bypass the lifecycle engine.
- Do not create parallel event systems.
- Reuse existing logging and audit infrastructure.
- Prefer extending policy and routing rather than hardcoding behavior.
- Keep modules loosely coupled and deterministic.

Every change must move the system closer to: **Responsibility-aware orchestration of property operations.**

---

## One Sentence Summary

**Propera is not a ticket system.**  
**Propera is the operating system that coordinates the signals, people, and processes required to run buildings.**
