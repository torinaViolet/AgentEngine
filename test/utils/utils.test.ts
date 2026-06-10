import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateId } from "../../src/utils";

describe("generateId", () => {
  it("generates an id without a prefix", () => {
    const id = generateId();

    assert.match(id, /^[a-z0-9]+-[a-z0-9]+$/);
  });

  it("generates an id with a prefix", () => {
    const id = generateId("run");

    assert.match(id, /^run-[a-z0-9]+-[a-z0-9]+$/);
  });

  it("generates different ids across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId("test")));

    assert.equal(ids.size, 100);
  });
});
