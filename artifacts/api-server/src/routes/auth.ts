import { Router } from "express";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { eq, or, and, isNull } from "drizzle-orm";
import { db, users, inviteCodes, pool } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { logger } from "../lib/logger.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { registerSchema, loginSchema, adminCreateUserSchema, changePasswordSchema } from "../lib/validators/auth.js";

const router = Router();

/** Drop connect-pg-simple rows for a user. keepSid = leave the current browser session alive (self password change). */
async function invalidateUserSessions(userId: number, keepSid?: string): Promise<number> {
  const r = keepSid
    ? await pool.query(
        `DELETE FROM session WHERE (sess->>'userId')::int = $1 AND sid <> $2`,
        [userId, keepSid],
      )
    : await pool.query(`DELETE FROM session WHERE (sess->>'userId')::int = $1`, [userId]);
  return r.rowCount ?? 0;
}

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

  // A235: regenerate sid on login so a stolen pre-login cookie can't inherit the session.
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
  req.session.userId = user.id;
  req.session.role = user.role as "admin" | "member";

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

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

// POST /auth/change-password
router.post("/auth/change-password", requireAuth, validate(changePasswordSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };

  const [user] = await db.select().from(users).where(eq(users.id, req.session.userId!)).limit(1);
  if (!user) return res.status(404).json({ error: "User not found" });

  const match = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!match) return res.status(401).json({ error: "Current password is incorrect" });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  // Kill other sessions; keep this one so Jamie isn't locked out mid-market (A235).
  const dropped = await invalidateUserSessions(user.id, req.sessionID);
  logger.info({ userId: user.id, droppedSessions: dropped }, "auth: password changed");
  return res.json({ ok: true });
});

// POST /admin/users — admin creates an account directly, no invite code needed
router.post("/admin/users", requireAdmin, validate(adminCreateUserSchema), async (req, res) => {
  const { email, username, password, role } = req.body as {
    email: string; username: string; password: string; role: "admin" | "member";
  };

  const existing = await db.select({ id: users.id }).from(users)
    .where(or(eq(users.email, email), eq(users.username, username)))
    .limit(1);
  if (existing.length > 0) {
    return res.status(409).json({ error: "Email or username already taken" });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [newUser] = await db.insert(users).values({ email, username, passwordHash, role }).returning();

  logger.info({ userId: newUser.id, createdBy: req.session.userId }, "admin: user created directly");
  return res.status(201).json({
    id: newUser.id, email: newUser.email, username: newUser.username, role: newUser.role,
  });
});

// POST /admin/invite
router.post("/admin/invite", requireAdmin, async (req, res) => {
  const code = randomBytes(8).toString("hex").toUpperCase();
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
      id:          users.id,
      email:       users.email,
      username:    users.username,
      role:        users.role,
      createdAt:   users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .orderBy(users.createdAt);
  return res.json(rows);
});

// POST /admin/users/:id/reset-password — admin sets a new temp password for a user
router.post("/admin/users/:id/reset-password", requireAdmin, async (req, res) => {
  const id = Number(req.params['id']);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid user id" });

  const tempPassword = randomBytes(6).toString("hex");
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  const result = await db.update(users).set({ passwordHash }).where(eq(users.id, id)).returning({ id: users.id });
  if (result.length === 0) return res.status(404).json({ error: "User not found" });

  const dropped = await invalidateUserSessions(id);
  logger.info({ userId: id, resetBy: req.session.userId, droppedSessions: dropped }, "admin: user password reset");
  return res.json({ id, tempPassword });
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
