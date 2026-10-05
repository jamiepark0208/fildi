import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getLocalStackStatus } from "../lib/local-stack.js";

const router = Router();

/**
 * Mac local-dev stack status (API + Vite pidfiles / port orphans).
 * Read-only. Disabled outside NODE_ENV=development (unless LOCAL_STACK_STATUS=1).
 */
router.get("/admin/local-stack", requireAdmin, (_req, res) => {
  res.json(getLocalStackStatus());
});

export default router;
