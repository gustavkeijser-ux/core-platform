import { createClient } from "@supabase/supabase-js";

// Lovable Cloud genererade tidigare den här filen automatiskt. Nu sätts
// den upp manuellt mot ett vanligt Supabase-projekt. Nycklarna kommer från
// Project Settings -> API i Supabase-dashboarden.
const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY saknas. Kopiera .env.example till .env och fyll i värdena från Supabase-projektet."
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
