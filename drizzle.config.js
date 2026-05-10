import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/auth/schema.js",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.SQLITE_PATH ?? "./logs/auth.db",
  },
  verbose: true,
  strict: true,
});
