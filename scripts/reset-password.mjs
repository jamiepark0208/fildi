#!/usr/bin/env node
/**
 * Reset a user's password in PostgreSQL (Replit: run with DATABASE_URL set).
 * Usage: node scripts/reset-password.mjs you@example.com NewPassword123
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.error("Usage: node scripts/reset-password.mjs <email> <new-password>");
  process.exit(1);
}

if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
const client = new pg.Client({ connectionString: url });
await client.connect();

const res = await client.query(
  "UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id, email, username",
  [hash, email],
);

if (res.rowCount === 0) {
  console.error(`No user found for email: ${email}`);
  await client.end();
  process.exit(1);
}

console.log(`Password updated for ${res.rows[0].email} (${res.rows[0].username})`);
await client.end();
