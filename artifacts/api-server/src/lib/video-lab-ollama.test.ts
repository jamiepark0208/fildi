import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateVideoHooks } from "./video-lab-ollama.js";

describe("A125 video-lab-ollama", () => {
  it("returns template ideas when Ollama is unreachable", async () => {
    process.env.OLLAMA_URL = "http://127.0.0.1:1";
    const out = await generateVideoHooks("fed cuts");
    assert.equal(out.source, "template");
    assert.ok(out.ideas.length >= 2);
    assert.ok(out.ideas[0]!.hook.toLowerCase().includes("fed") || out.ideas[0]!.topic.includes("fed"));
  });
});
