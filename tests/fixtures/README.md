# Tenant golden fixtures

| File | Role |
|------|------|
| `tenant-messages.json` | **Canonical** — 61 rows (Claude core set + wrapper metadata) |
| `tenant-messages-claude-core.json` | Flat array only — edit here, then rebuild wrapper (see below) |

## Rebuild `tenant-messages.json` after editing core

```bash
node -e "const fs=require('fs');const c=require('./tests/fixtures/tenant-messages-claude-core.json');const j=require('./tests/fixtures/tenant-messages.json');j.messages=c;fs.writeFileSync('./tests/fixtures/tenant-messages.json',JSON.stringify(j,null,2));"
```

## What the tests can enforce today

| Layer | Code | Fixture `action` examples |
|-------|------|---------------------------|
| **Compile** | `compileTurn` + `tenantMessagesCompile.test.js` | Issue/unit/emergency extraction |
| **Pipeline** | `runInboundPipeline` + in-memory Supabase (TODO) | `NO_TICKET`, `SPLIT_TICKET`, `UPDATE_TICKET`, dedupe |

Run:

```bash
npm test -- tests/tenantMessagesCompile.test.js          # baseline (≤9 compile gaps OK)
TENANT_GOLDEN_STRICT=1 npm test -- tests/tenantMessagesCompile.test.js  # agent must hit zero
```

**Pipeline scenarios:** require `tests/helpers/legacyPipelineEnv.js` first so `.env` `TENANT_AGENT_ENABLED=1` does not affect legacy slot-machine tests. Agent tests set `TENANT_AGENT_ENABLED=1` in-file.
