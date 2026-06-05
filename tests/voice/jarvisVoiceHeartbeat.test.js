const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  heartbeatSweep,
} = require("../../src/voice/jarvisVoiceWebSocketBridge");

/** Minimal fake client socket tracking ping/terminate calls. */
function fakeClient(isAlive) {
  return {
    isAlive,
    pinged: 0,
    terminated: 0,
    ping() {
      this.pinged += 1;
    },
    terminate() {
      this.terminated += 1;
    },
  };
}

describe("heartbeatSweep", () => {
  it("pings a live client and flips it to not-alive (awaiting pong)", () => {
    const c = fakeClient(true);
    heartbeatSweep([c]);
    assert.equal(c.pinged, 1);
    assert.equal(c.terminated, 0);
    assert.equal(c.isAlive, false);
  });

  it("terminates a client that missed the previous pong", () => {
    const c = fakeClient(false);
    heartbeatSweep([c]);
    assert.equal(c.terminated, 1);
    assert.equal(c.pinged, 0);
  });

  it("two sweeps without a pong terminate the socket", () => {
    const c = fakeClient(true);
    heartbeatSweep([c]); // alive -> pinged, isAlive=false
    heartbeatSweep([c]); // still not alive -> terminate
    assert.equal(c.pinged, 1);
    assert.equal(c.terminated, 1);
  });

  it("a pong between sweeps keeps the socket alive", () => {
    const c = fakeClient(true);
    heartbeatSweep([c]); // isAlive=false, pinged
    c.isAlive = true; // simulate pong handler
    heartbeatSweep([c]); // alive again -> pinged, not terminated
    assert.equal(c.pinged, 2);
    assert.equal(c.terminated, 0);
  });

  it("tolerates empty / nullish input", () => {
    assert.doesNotThrow(() => heartbeatSweep([]));
    assert.doesNotThrow(() => heartbeatSweep(null));
  });
});
