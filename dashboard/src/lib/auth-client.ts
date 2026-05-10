import { createAuthClient } from "better-auth/react"

// Same-origin: dashboard and logServer are served from the same host. Vite
// proxies /api → :3456 in dev (see vite.config.ts), so cookies flow naturally.
export const authClient = createAuthClient({
  basePath: "/api/auth",
})

export const { useSession, signIn, signOut } = authClient
