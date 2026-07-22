import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db, feedback, users } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { validate } from "../middleware/validate.js";
import { feedbackSchema } from "../lib/validators/feedback.js";

const router = Router();

router.use(requireAuth);

// POST /feedback
router.post("/feedback", validate(feedbackSchema), async (req, res) => {
  const { message, page } = req.body as { message: string; page?: string };
  await db.insert(feedback).values({ userId: req.session.userId!, message, page: page ?? null });
  return res.status(201).json({ ok: true });
});

// GET /admin/feedback
router.get("/admin/feedback", requireAdmin, async (_req, res) => {
  const rows = await db.select({
    id: feedback.id,
    message: feedback.message,
    page: feedback.page,
    createdAt: feedback.createdAt,
    username: users.username,
  })
    .from(feedback)
    .innerJoin(users, eq(feedback.userId, users.id))
    .orderBy(desc(feedback.createdAt));
  return res.json(rows);
});

export default router;
