import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";

// One shared database client for the whole app. In development, Next.js reloads
// files on every save, so we keep the client on globalThis to avoid opening a new
// connection pool each time.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Add it to .env.local (and to Vercel's environment variables).");
  }
  // DATABASE_URL is Supabase's pooled connection (port 6543), suited to serverless hosting.
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Not exported on purpose: this client connects as the table owner, which skips
// the database's row level security rules. The rest of the app can only reach
// the database through runAsUser below.
const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

// The database handle passed to code running inside runAsUser.
export type Db = Prisma.TransactionClient;

// Runs `work` with the database's row level security switched on for one user.
//
// It opens a transaction (a group of queries the database treats as one unit:
// all of it happens or none of it does) and, for that transaction only:
//   - switches to the limited app_user role, which the rules apply to, and
//   - records which user is signed in (app.user_id), which the rules compare
//     each row's owner with.
// So even a query that forgot its userId filter only sees this user's rows.
// The `true` in set_config means "only until this transaction ends", so the
// connection goes back to normal before anyone else's request reuses it.
//
// userId must come from getCurrentUser() (a verified login), never from input.
export async function runAsUser<T>(userId: string, work: (tx: Db) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('role', 'app_user', true), set_config('app.user_id', ${userId}, true)`;
    return work(tx);
  });
}
