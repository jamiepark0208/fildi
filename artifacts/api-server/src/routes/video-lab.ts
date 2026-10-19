/** A125 — Video Lab API (metadata; mp4 upload phase later). */
import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { insertIdea, listIdeas, listVideos, saveUploadedVideo } from "../lib/video-lab.js";

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
    const id = await insertIdea({ topic, hook, outline });
    res.json({ id });
  } catch (err) {
    next(err);
  }
});

export default router;

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
