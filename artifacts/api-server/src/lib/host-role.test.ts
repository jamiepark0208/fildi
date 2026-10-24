import assert from "node:assert/strict";
import test from "node:test";
import { getHostRole, isPublicHost } from "./host-role.js";

test("host-role defaults to mac", () => {
  const prev = process.env.FILDI_HOST_ROLE;
  delete process.env.FILDI_HOST_ROLE;
  assert.equal(getHostRole(), "mac");
  assert.equal(isPublicHost(), false);
  process.env.FILDI_HOST_ROLE = "public";
  assert.equal(getHostRole(), "public");
  assert.equal(isPublicHost(), true);
  process.env.FILDI_HOST_ROLE = "PUBLIC";
  assert.equal(getHostRole(), "public");
  if (prev === undefined) delete process.env.FILDI_HOST_ROLE;
  else process.env.FILDI_HOST_ROLE = prev;
});
