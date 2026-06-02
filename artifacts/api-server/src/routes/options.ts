import { Router } from "express";
import { getOptionsChain } from "../lib/options.js";

const router = Router();

// GET /api/options/:ticker
router.get("/options/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  if (!/^[A-Z]{1,10}$/.test(ticker)) {
    return res.status(400).json({ error: "Invalid ticker" });
  }
  try {
    const result = await getOptionsChain(ticker);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
