-- Lock Prisma's own bookkeeping table away from Supabase's public web API,
-- the same way as the app tables in the init migration. Wrapped in a check
-- because Prisma's temporary "shadow" database (used to test migrations)
-- doesn't have this table.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    ALTER TABLE public."_prisma_migrations" ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public."_prisma_migrations" FROM anon, authenticated;
  END IF;
END
$$;

-- Make every table created from now on start locked too, so new tables are
-- never exposed by accident. (Applies to tables created by the postgres role,
-- which is the role Prisma migrations run as.)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
