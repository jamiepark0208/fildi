import { Router } from "express";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { eq, or, and, isNull } from "drizzle-orm";
import { db, users, inviteCodes } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { logger } from "../lib/logger.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { registerSchema, loginSchema } from "../lib/validators/auth.js";

const router = Router();

// POST /auth/register
router.post("/auth/register", authLimiter, validate(registerSchema), async (req, res) => {
  const { email, username, password, inviteCode } = req.body as {
    email: string; username: string; password: string; inviteCode: string;
  };

  const invite = await db.select().from(inviteCodes)
    .where(and(eq(inviteCodes.code, inviteCode), isNull(inviteCodes.usedBy)))
    .limit(1);
  if (invite.length === 0) {
    return res.status(403).json({ error: "Invalid or already-used invite code" });
  }

  const existing = await db.select({ id: users.id }).from(users)
    .where(or(eq(users.email, email), eq(users.username, username)))
    .limit(1);
  if (existing.length > 0) {
    return res.status(409).json({ error: "Email or username already taken" });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [newUser] = await db.insert(users).values({ email, username, passwordHash, role: "member" }).returning();

  await db.update(inviteCodes)
    .set({ usedBy: newUser.id, usedAt: new Date() })
    .where(eq(inviteCodes.code, inviteCode));

  req.session.userId = newUser.id;
  req.session.role = newUser.role as "admin" | "member";

  logger.info({ userId: newUser.id }, "auth: user registered");
  return res.status(201).json({ id: newUser.id, email: newUser.email, username: newUser.username, role: newUser.role });
});

// POST /auth/login
router.post("/auth/login", authLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  req.session.userId = user.id;
  req.session.role = user.role as "admin" | "member";

  logger.info({ userId: user.id }, "auth: user logged in");
  return res.status(200).json({ id: user.id, email: user.email, username: user.username, role: user.role });
});

// POST /auth/logout
router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /auth/me
router.get("/auth/me", requireAuth, async (req, res) => {
  const [user] = await db.select({
    id: users.id,
    email: users.email,
    username: users.username,
    role: users.role,
    avatarUrl: users.avatarUrl,
  }).from(users).where(eq(users.id, req.session.userId!)).limit(1);

  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json(user);
});

// POST /admin/invite
router.post("/admin/invite", requireAdmin, async (req, res) => {
  const code = randomBytes(4).toString("hex").toUpperCase();
  await db.insert(inviteCodes).values({ code, createdBy: req.session.userId! });
  logger.info({ code, createdBy: req.session.userId }, "admin: invite code created");
  return res.json({ code });
});

// GET /admin/invites
router.get("/admin/invites", requireAdmin, async (_req, res) => {
  const codes = await db
    .select({
      code:         inviteCodes.code,
      createdBy:    inviteCodes.createdBy,
      usedBy:       inviteCodes.usedBy,
      createdAt:    inviteCodes.createdAt,
      usedAt:       inviteCodes.usedAt,
      usedByEmail:  users.email,
    })
    .from(inviteCodes)
    .leftJoin(users, eq(users.id, inviteCodes.usedBy))
    .orderBy(inviteCodes.createdAt);
  return res.json(codes);
});

// GET /admin/users
router.get("/admin/users", requireAdmin, async (_req, res) => {
  const rows = await db
    .select({
      id:        users.id,
      email:     users.email,
      username:  users.username,
      role:      users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);
  return res.json(rows);
});

// DELETE /admin/invite/:code
router.delete("/admin/invite/:code", requireAdmin, async (req, res) => {
  const code = req.params['code'] as string;
  const result = await db.delete(inviteCodes).where(eq(inviteCodes.code, code)).returning({ code: inviteCodes.code });
  if (result.length === 0) return res.status(404).json({ error: "Code not found" });
  logger.info({ code }, "admin: invite code deleted");
  return res.json({ deleted: code, ok: true });
});

export default router;
