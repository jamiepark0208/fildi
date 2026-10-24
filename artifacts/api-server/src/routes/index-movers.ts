/** A267: latest Schwab index movers ($SPX / $COMPX / $DJI). Display only. */
import { Router } from "express";
import { readIndexMovers } from "../lib/unused-feeds.js";

const router = Router();

router.get("/live/index-movers", async (_req, res, next) => {
  try {
    res.json(await readIndexMovers());
  } catch (err) {
    next(err);
  }
});

export default router;
