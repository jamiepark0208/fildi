/** A125 — Video Lab API (metadata; mp4 upload phase later). */
import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { insertIdea, listIdeas, listVideos } from "../lib/video-lab.js";

const router = Router();

router.get("/video-lab", requireAdmin, async (_req, res, next) => {
  try {
    const [ideas, videos] = await Promise.all([listIdeas(), listVideos()]);
    res.json({
      ideas,
      videos,
      note: "A125 Phase 1 — metadata only. Upload + Ollama hooks next.",
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
