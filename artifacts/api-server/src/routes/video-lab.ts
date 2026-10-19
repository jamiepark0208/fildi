/** A125 — Video Lab API (metadata; mp4 upload phase later). */
import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  deleteVideo,
  getVideoFilePath,
  insertIdea,
  listIdeas,
  listVideos,
  saveUploadedVideo,
} from "../lib/video-lab.js";
import { generateVideoHooks } from "../lib/video-lab-ollama.js";

const router = Router();

router.get("/video-lab", requireAdmin, async (_req, res, next) => {
  try {
    const [ideas, videos] = await Promise.all([listIdeas(), listVideos()]);
    res.json({
      ideas,
      videos,
      note: "A125 — metadata + disk upload (~/.fildi/videos). Ollama hooks next.",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/video-lab/ideas", requireAdmin, async (req, res, next) => {
  try {
    const topic = String(req.body?.topic ?? "").trim();
    const hook = String(req.body?.hook ?? "").trim();
    if (topic.length < 2 || hook.length < 2) {
      res.status(400).json({ error: "topic and hook required" });
      return;
    }
    const outline = Array.isArray(req.body?.outline) ? req.body.outline : [];
    const id = await insertIdea({
      topic, hook, outline,
      source: req.body?.source != null ? String(req.body.source) : "idea",
      sourceUrl: req.body?.sourceUrl != null ? String(req.body.sourceUrl) : null,
      asksRef: req.body?.asksRef != null ? String(req.body.asksRef) : null,
      notes: req.body?.notes != null ? String(req.body.notes) : null,
    });
    res.json({ id });
  } catch (err) {
    next(err);
  }
});

/** A125 — stream mp4 for inline preview (path must be under Video Lab dir). */
router.get("/video-lab/videos/:id/file", requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "id required" });
      return;
    }
    const path = await getVideoFilePath(id);
    if (!path) {
      res.status(404).json({ error: "video file not found" });
      return;
    }
    const ext = extname(path).toLowerCase();
    const type =
      ext === ".webm" ? "video/webm" : ext === ".mov" ? "video/quicktime" : "video/mp4";
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "private, max-age=3600");
    createReadStream(path).pipe(res);
  } catch (err) {
    next(err);
  }
});

/** A125 — delete upload (disk + row). */
router.delete("/video-lab/videos/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "id required" });
      return;
    }
    const ok = await deleteVideo(id);
    if (!ok) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** A125 — local Whisper transcript for an uploaded video. */
router.post("/video-lab/videos/:id/transcribe", requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "id required" });
      return;
    }
    const { transcribeVideoLab } = await import("../lib/video-lab-whisper.js");
    const result = await transcribeVideoLab(id);
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    next(err);
  }
});

/** A125 — upload short: JSON { title, filename, dataBase64, hook?, topic?, notes? }. */
router.post("/video-lab/videos", requireAdmin, async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? "").trim();
    const filename = String(req.body?.filename ?? "clip.mp4").trim();
    const b64 = String(req.body?.dataBase64 ?? "");
    if (!title || !b64) {
      res.status(400).json({ error: "title and dataBase64 required" });
      return;
    }
    const bytes = Buffer.from(b64, "base64");
    const out = await saveUploadedVideo({
      title,
      filename,
      bytes,
      hook: req.body?.hook != null ? String(req.body.hook) : null,
      topic: req.body?.topic != null ? String(req.body.topic) : null,
      notes: req.body?.notes != null ? String(req.body.notes) : null,
    });
    res.json(out);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (msg.includes("too large") || msg.includes("only mp4") || msg.includes("empty")) {
      res.status(400).json({ error: msg });
      return;
    }
    next(err);
  }
});

/** A125 — brainstorm hooks via local Ollama (template fallback if offline). */
router.post("/video-lab/hooks", requireAdmin, async (req, res, next) => {
  try {
    const topic = String(req.body?.topic ?? "").trim();
    if (topic.length < 2) {
      res.status(400).json({ error: "topic required" });
      return;
    }
    const save = Boolean(req.body?.save);
    const out = await generateVideoHooks(topic);
    const ids: number[] = [];
    if (save) {
      for (const idea of out.ideas) {
        ids.push(await insertIdea({ topic: idea.topic, hook: idea.hook, outline: idea.outline }));
      }
    }
    res.json({ ...out, savedIds: ids });
  } catch (err) {
    next(err);
  }
});

/** A125 — Reel inbox: paste IG/URL + one-line take (+ optional ASKS ref). */
router.post("/video-lab/reels", requireAdmin, async (req, res, next) => {
  try {
    const url = String(req.body?.sourceUrl ?? req.body?.url ?? "").trim();
    const take = String(req.body?.take ?? req.body?.hook ?? "").trim();
    const topic = String(req.body?.topic ?? "reel").trim() || "reel";
    if (url.length < 8 || take.length < 4) {
      res.status(400).json({ error: "sourceUrl and take required" });
      return;
    }
    const id = await insertIdea({
      topic,
      hook: take,
      outline: ["reel", "take", "asks?"],
      status: "inbox",
      source: "reel",
      sourceUrl: url,
      asksRef: req.body?.asksRef != null ? String(req.body.asksRef) : null,
      notes: req.body?.notes != null ? String(req.body.notes) : null,
    });
    res.json({ id });
  } catch (err) {
    next(err);
  }
});

export default router;
