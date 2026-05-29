/**
 * Piece 5 — Access scenario replay.
 *
 * Discovers every `*.json` fixture in ./fixtures/ and replays it through
 * the agent->brain seam via {@link ../scenarios/access/runScenario.js}.
 *
 * This is the regression gate for the access engine — see ./fixtures/README.md
 * for fixture authoring guidance.
 */

const { runScenario } = require("./runScenario");
const { test, describe } = require("node:test");
const fs = require("fs");
const path = require("path");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

const fixtureFiles = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

// Run fixtures serially — each fixture installs global hooks (Date freeze,
// Supabase client, LLM mock, tenantAccessService stub) so concurrent execution
// would clobber them and produce nondeterministic failures.
describe("scenarios/access — golden fixtures", { concurrency: 1 }, () => {
  for (const filename of fixtureFiles) {
    const filepath = path.join(FIXTURES_DIR, filename);
    let fixture;
    try {
      fixture = JSON.parse(fs.readFileSync(filepath, "utf8"));
    } catch (err) {
      test(`${filename} parses`, () => {
        throw new Error(`Failed to parse ${filename}: ${err.message}`);
      });
      continue;
    }

    const title = fixture.name || filename.replace(/\.json$/, "");
    test(title, async () => {
      await runScenario(fixture);
    });
  }
});
