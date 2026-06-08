import { Router } from "express";
import { getOptionsChain, getOptionPositionQuote } from "../lib/options.js";

const router = Router();

// GET /api/options/position-quote?ticker=NVDA&expiry=2026-06-20&strike=850&type=call
// MUST be declared before /options/:ticker so it isn't captured by the wildcard
router.get("/options/position-quote", async (req, res) => {
  const { ticker, expiry, strike, type } = req.query;
  if (
    typeof ticker !== "string" || !/^[A-Z0-9._-]{1,15}$/i.test(ticker) ||
    typeof expiry !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) ||
    typeof strike !== "string" || isNaN(Number(strike)) ||
    (type !== "call" && type !== "put")
  ) {
    return res.status(400).json({ error: "Invalid parameters" });
  }
  try {
    const result = await getOptionPositionQuote(
      ticker.toUpperCase(),
      expiry,
      Number(strike),
      type as "call" | "put",
    );
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /api/options/:ticker  — full chain scan
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
