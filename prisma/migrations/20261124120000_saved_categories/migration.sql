-- Saved categories (g1). Purely additive: one new column, a function and a
-- trigger. Nothing existing is removed or renamed, and the app's current code
-- simply ignores the new column, so the live site keeps working as before.

-- 1. A category is either on the user's saved list or a one-off typed for some
--    task(s) only. Every existing category starts as a one-off...
ALTER TABLE "Category" ADD COLUMN "saved" BOOLEAN NOT NULL DEFAULT false;

-- 2. ...then the existing account's main categories become saved, so they
--    don't have to be set up again (chosen with the user: their other old
--    categories stay as unused one-offs, which are never shown).
UPDATE "Category" SET "saved" = true WHERE "name" IN ('Work', 'Personal', 'Errands', 'Fitness');

-- 3. Every NEW account starts with four saved categories (they can be renamed
--    or deleted in Settings). Runs when an account is created in Supabase's own
--    auth.users table, so existing accounts never get them.
CREATE OR REPLACE FUNCTION public.add_starter_categories()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO "Category" ("id", "userId", "name", "saved")
  VALUES
    (gen_random_uuid(), NEW.id, 'Work', true),
    (gen_random_uuid(), NEW.id, 'Fitness', true),
    (gen_random_uuid(), NEW.id, 'Errands', true),
    (gen_random_uuid(), NEW.id, 'Personal', true)
  ON CONFLICT ("userId", "name") DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never stop someone signing up over this: they'd just start with no categories.
  RETURN NEW;
END;
$$;

-- Only the trigger may run it: not the public web API, not the app's role.
REVOKE ALL ON FUNCTION public.add_starter_categories() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_starter_categories() FROM anon, authenticated, app_user;

CREATE TRIGGER add_starter_categories
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.add_starter_categories();
