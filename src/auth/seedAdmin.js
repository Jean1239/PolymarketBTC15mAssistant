// Idempotent admin bootstrap. Reads DASHBOARD_ADMIN_EMAIL +
// DASHBOARD_ADMIN_PASSWORD and creates the user via better-auth's internal
// context (bypasses disableSignUp). If a user with that email already exists,
// only the password is updated when DASHBOARD_ADMIN_RESET_PASSWORD=true.
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getAuth } from "./instance.js";
import { getDb, closeDb, schema } from "./db.js";

export async function seedAdmin() {
  const email = process.env.DASHBOARD_ADMIN_EMAIL;
  const password = process.env.DASHBOARD_ADMIN_PASSWORD;
  const name = process.env.DASHBOARD_ADMIN_NAME ?? "Admin";

  if (!email || !password) {
    return { skipped: true, reason: "DASHBOARD_ADMIN_EMAIL or DASHBOARD_ADMIN_PASSWORD not set" };
  }
  if (password.length < 12) {
    throw new Error("DASHBOARD_ADMIN_PASSWORD must be at least 12 characters");
  }

  const auth = getAuth();
  const db = getDb();
  const ctx = await auth.$context;

  const existing = await db.select().from(schema.user).where(eq(schema.user.email, email)).limit(1);

  if (existing.length > 0) {
    if (process.env.DASHBOARD_ADMIN_RESET_PASSWORD !== "true") {
      return { skipped: true, reason: "user exists; set DASHBOARD_ADMIN_RESET_PASSWORD=true to reset", userId: existing[0].id };
    }
    const hashed = await ctx.password.hash(password);
    await db
      .update(schema.account)
      .set({ password: hashed, updatedAt: new Date() })
      .where(eq(schema.account.userId, existing[0].id));
    return { reset: true, userId: existing[0].id };
  }

  const userId = randomUUID();
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name,
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });

  const hashed = await ctx.password.hash(password);
  await db.insert(schema.account).values({
    id: randomUUID(),
    userId,
    accountId: userId,
    providerId: "credential",
    password: hashed,
    createdAt: now,
    updatedAt: now,
  });

  return { created: true, userId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await seedAdmin();
    console.log("Admin seed:", result);
  } catch (err) {
    console.error("Admin seed failed:", err);
    process.exit(1);
  } finally {
    closeDb();
  }
}
