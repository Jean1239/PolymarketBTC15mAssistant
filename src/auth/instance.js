import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb, schema } from "./db.js";

let authInstance;

function buildTrustedOrigins() {
  const raw = process.env.AUTH_TRUSTED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getAuth() {
  if (authInstance) return authInstance;

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");

  const baseURL = process.env.BETTER_AUTH_URL;
  if (!baseURL) throw new Error("BETTER_AUTH_URL is not set");

  authInstance = betterAuth({
    secret,
    baseURL,
    basePath: "/api/auth",
    trustedOrigins: buildTrustedOrigins(),
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // Closed dashboard: only the seeded admin (and any user provisioned via
      // db:seed-admin) can authenticate. The public /sign-up endpoint is gated
      // by a middleware in logServer.js so unauthenticated requests get 403.
      disableSignUp: true,
      autoSignIn: true,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
  });

  return authInstance;
}
