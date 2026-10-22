import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeLsegDesktopProxy, probeTcp, readLsegPortInUse } from "./research-ops.js";

describe("LSEG desktop proxy discovery", () => {
  it("readLsegPortInUse returns an integer when .portInUse exists", () => {
    const n = readLsegPortInUse();
    if (n != null) assert.ok(Number.isInteger(n) && n > 0 && n < 65536, String(n));
  });

  it("probeTcp is false on a closed high port", async () => {
    assert.equal(await probeTcp("127.0.0.1", 1, 200), false);
  });

  it("probeLsegDesktopProxy finds Workspace when .portInUse points at a live port", async () => {
    const fromFile = readLsegPortInUse();
    const got = await probeLsegDesktopProxy();
    if (fromFile != null && (await probeTcp("127.0.0.1", fromFile, 400))) {
      assert.equal(got.reachable, true);
      assert.equal(got.port, fromFile);
    }
  });
});
