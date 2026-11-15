// Prisma command-line settings (used by `prisma migrate`, `prisma studio`, etc.).
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Our secrets live in .env.local (the Next.js convention); Prisma doesn't load it on its own.
config({ path: ".env.local", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations need a direct connection (port 5432), not the pooled one (port 6543)
    // that the running app uses. Left optional so `prisma generate` still works
    // during Vercel builds, where only the app's pooled connection is configured.
    url: process.env.DIRECT_URL,
  },
});
