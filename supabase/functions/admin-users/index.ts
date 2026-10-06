// =====================================================================
//  ADMIN-USERS — användaradministration i CRM:et (Administration → Användare).
//
//  Bara administratörer (is_admin()) kommer åt funktionen. Allt sker inom
//  anroparens tenant (my_tenant_id()). Auth-kontot skapas med service-nyckeln
//  via Supabase Admin API, resten (profil, roller) i public-schemat.
//
//  Åtgärder (POST { action, ... }):
//    list                       → användare med roller och senaste inloggning, samt alla roller
//    create { email, fullName, roleKeys, mode: "password" | "invite", password? }
//        password: tillfälligt lösenord (genereras om det saknas) som visas en gång
//                  för admin; användaren tvingas byta vid första inloggningen.
//        invite:   Supabase skickar en inbjudningslänk per e-post (kräver SMTP i Auth).
//    set_roles { userId, roleKeys }
//
//  Skydd: en admin kan inte ta bort sin egen admin-roll (ingen utelåsning).
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://crm.connectestate.se";
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Läsbart tillfälligt lösenord: 3 ord-liknande block + siffror, utan tvetydiga tecken. */
function tempPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const pick = (s: string, n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => s[x % s.length]).join("");
  return `${pick(chars, 4)}-${pick(chars, 4)}-${pick(digits, 4)}`;
}

type Role = { id: string; key: string; name: string };

async function listUsers(tenantId: string) {
  const [{ data: users, error: e1 }, { data: roles, error: e2 }, { data: ur, error: e3 }] = await Promise.all([
    db.from("users").select("id, email, full_name, is_active, must_change_password, created_at")
      .eq("tenant_id", tenantId).is("deleted_at", null).order("full_name"),
    db.from("roles").select("id, key, name").eq("tenant_id", tenantId).order("name"),
    db.from("user_roles").select("user_id, role_id").eq("tenant_id", tenantId),
  ]);
  if (e1 || e2 || e3) throw new Error((e1 ?? e2 ?? e3)!.message);

  // Senaste inloggning finns bara i auth.users — hämtas via Admin API (sidvis).
  const lastSignIn = new Map<string, string | null>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) break;
    for (const u of data.users) lastSignIn.set(u.id, u.last_sign_in_at ?? null);
    if (data.users.length < 200) break;
  }

  const roleById = new Map((roles ?? []).map((r) => [r.id, r as Role]));
  const rolesOf = new Map<string, Role[]>();
  for (const x of ur ?? []) {
    const r = roleById.get(x.role_id);
    if (r) rolesOf.set(x.user_id, [...(rolesOf.get(x.user_id) ?? []), r]);
  }
  return {
    users: (users ?? []).map((u) => ({
      id: u.id, email: u.email, fullName: u.full_name, isActive: u.is_active,
      mustChangePassword: u.must_change_password, createdAt: u.created_at,
      lastSignInAt: lastSignIn.get(u.id) ?? null,
      roles: (rolesOf.get(u.id) ?? []).sort((a, b) => a.name.localeCompare(b.name, "sv")),
    })),
    roles: (roles ?? []) as Role[],
  };
}

async function setRoles(tenantId: string, userId: string, roleKeys: string[], callerId: string) {
  const { data: u } = await db.from("users").select("id").eq("id", userId).eq("tenant_id", tenantId).maybeSingle();
  if (!u) throw new Error("Användaren finns inte.");
  const { data: roles } = await db.from("roles").select("id, key").eq("tenant_id", tenantId).in("key", roleKeys);
  const wanted = roles ?? [];
  if (wanted.length !== new Set(roleKeys).size) throw new Error("Okänd roll.");
  if (userId === callerId && !roleKeys.includes("admin")) throw new Error("Du kan inte ta bort din egen administratörsroll.");

  const { error: e1 } = await db.from("user_roles").delete().eq("user_id", userId).eq("tenant_id", tenantId);
  if (e1) throw new Error(e1.message);
  if (wanted.length) {
    const { error: e2 } = await db.from("user_roles").insert(wanted.map((r) => ({ user_id: userId, role_id: r.id, tenant_id: tenantId })));
    if (e2) throw new Error(e2.message);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return fail("Ej inloggad", 401);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* tom kropp */ }

  // Vem anropar? Admin-kontroll och tenant via RLS-funktionerna som användaren.
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const [{ data: me }, { data: isAdmin }, { data: tenantId }] = await Promise.all([
    userDb.auth.getUser(), userDb.rpc("is_admin"), userDb.rpc("my_tenant_id"),
  ]);
  const callerId = me?.user?.id;
  if (!callerId || !tenantId) return fail("Ej inloggad", 401);
  if (!isAdmin) return fail("Åtkomst nekad — admin krävs.", 403);

  try {
    switch (String(b.action ?? "")) {
      case "list":
        return json(await listUsers(tenantId));

      case "set_roles": {
        const userId = str(b.userId, 40);
        const roleKeys = Array.isArray(b.roleKeys) ? b.roleKeys.map((k) => str(k, 60)).filter(Boolean) : [];
        await setRoles(tenantId, userId, roleKeys, callerId);
        return json({ ok: true });
      }

      case "create": {
        const email = str(b.email, 200).toLowerCase();
        const fullName = str(b.fullName, 120);
        const mode = b.mode === "invite" ? "invite" : "password";
        const roleKeys = Array.isArray(b.roleKeys) ? b.roleKeys.map((k) => str(k, 60)).filter(Boolean) : [];
        if (!EMAIL_RE.test(email)) return fail("Ange en giltig e-postadress.");
        if (!fullName) return fail("Ange namn.");
        const { data: dup } = await db.from("users").select("id").eq("tenant_id", tenantId).eq("email", email).maybeSingle();
        if (dup) return fail("Det finns redan en användare med den e-postadressen.");

        let userId: string;
        let password: string | null = null;
        if (mode === "password") {
          password = str(b.password, 80) || tempPassword();
          if (password.length < 8) return fail("Lösenordet måste vara minst 8 tecken.");
          const { data, error } = await db.auth.admin.createUser({
            email, password, email_confirm: true,
            app_metadata: { tenant_id: tenantId },
            user_metadata: { full_name: fullName },
          });
          if (error || !data.user) return fail(error?.message ?? "Kunde inte skapa kontot.");
          userId = data.user.id;
        } else {
          const { data, error } = await db.auth.admin.inviteUserByEmail(email, {
            data: { full_name: fullName }, redirectTo: APP_URL,
          });
          if (error || !data.user) return fail(error?.message ?? "Kunde inte skicka inbjudan (är e-post/SMTP konfigurerat i Supabase Auth?).");
          userId = data.user.id;
        }
        // Auth skriver raden innan app_metadata sätts (och inbjudan kan inte sätta den alls),
        // så sätt tenant_id uttryckligen efteråt — det är den som hamnar i JWT och styr RLS.
        const { error: e2 } = await db.auth.admin.updateUserById(userId, { app_metadata: { tenant_id: tenantId } });
        if (e2) return fail(e2.message);

        // Profilen: triggern (handle_new_auth_user) hoppar över raden när tenant saknas vid
        // insert, så vi skriver den själva här.
        const { error: e3 } = await db.from("users").upsert({
          id: userId, tenant_id: tenantId, email, full_name: fullName, must_change_password: true,
        }, { onConflict: "id" });
        if (e3) return fail(e3.message);

        if (roleKeys.length) await setRoles(tenantId, userId, roleKeys, callerId);
        return json({ ok: true, userId, password, mode });
      }

      default:
        return fail("Okänd åtgärd.");
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
});
