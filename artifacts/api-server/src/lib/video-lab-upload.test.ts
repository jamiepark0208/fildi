import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { videoLabDir, saveUploadedVideo } from "./video-lab.js";

describe("A125 saveUploadedVideo", () => {
  const dir = mkdtempSync(join(tmpdir(), "fildi-vid-"));
  const prev = process.env.FILDI_VIDEOS_DIR;
  process.env.FILDI_VIDEOS_DIR = dir;
  after(() => {
    if (prev === undefined) delete process.env.FILDI_VIDEOS_DIR;
    else process.env.FILDI_VIDEOS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  it("rejects non-video extension", async () => {
    await assert.rejects(
      () => saveUploadedVideo({ title: "x", filename: "a.txt", bytes: Buffer.from("hi") }),
      /only mp4/,
    );
  });
  it("writes bytes under FILDI_VIDEOS_DIR", async () => {
    // DB insert needs live Postgres — skip if DATABASE_URL missing
    if (!process.env.DATABASE_URL && !process.env.PGHOST) {
      assert.equal(videoLabDir(), dir);
      return;
    }
    const bytes = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]); // tiny ftyp-ish
    const out = await saveUploadedVideo({ title: "t", filename: "clip.mp4", bytes });
    assert.ok(out.path.startsWith(dir));
    assert.equal(readFileSync(out.path).length, bytes.length);
  });
});
