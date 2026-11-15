// Supabase project URL and publishable key. Both are safe to be public:
// the publishable key can only do what the database allows, and our tables
// are locked away from Supabase's public API (see prisma/migrations).
export function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set in .env.local (and in Vercel).",
    );
  }
  return { url, key };
}
