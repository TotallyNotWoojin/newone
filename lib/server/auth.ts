import type { Actor, SupportedLanguage } from "../types";
import { ensureDatabase, getD1 } from "./database";
import { runtimeValue } from "./runtime";

export class AuthenticationError extends Error {
  status = 401;
}

export class AuthorizationError extends Error {
  status = 403;
}

const DEMO_ACTOR: Actor = {
  email: "jiyoon@newone.demo",
  displayName: "김지윤 · Jiyoon",
  preferredLanguage: "ko",
  role: "manager",
};

const DEFAULT_THREAD_CATALOG = {
  operations: {
    title: "운영 · Operaciones",
    subtitle: "Private Korean–Spanish operations channel",
    kind: "operations",
    location: "",
  },
} as const;

export async function requireActor(request: Request): Promise<Actor> {
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  const allowDemo = process.env.NODE_ENV !== "production";

  if (!email && allowDemo) {
    await ensureDatabase();
    return DEMO_ACTOR;
  }
  if (!email) throw new AuthenticationError("Sign in is required");

  enforceAllowlist(email);
  await ensureDatabase();
  const name = decodeName(request.headers) ?? email.split("@")[0];
  const db = getD1();
  const existing = await db
    .prepare("SELECT display_name, preferred_language, role, active FROM profiles WHERE email = ? LIMIT 1")
    .bind(email)
    .first<{ display_name: string; preferred_language: SupportedLanguage; role: Actor["role"]; active: number }>();

  if (existing && !existing.active) {
    throw new AuthorizationError("This account has been deactivated");
  }

  if (!existing) {
    return provisionNewActor(email, name, roleForEmail(email));
  }

  return {
    email,
    displayName: existing.display_name,
    preferredLanguage: existing.preferred_language,
    role: existing.role,
  };
}

async function provisionNewActor(
  email: string,
  displayName: string,
  role: Actor["role"],
): Promise<Actor> {
  const db = getD1();
  const defaultThreads = configuredDefaultThreads();

  // D1 batch executes transactionally. The profile and its initial memberships
  // therefore commit together, while conflict-safe inserts handle concurrent
  // first requests without expanding access after a later revocation.
  await db.batch([
    ...defaultThreads.map((thread) =>
      db
        .prepare(
          `INSERT INTO threads (id, title, subtitle, kind, location)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          thread.id,
          thread.title,
          thread.subtitle,
          thread.kind,
          thread.location,
        ),
    ),
    db
      .prepare(
        `INSERT INTO profiles (email, display_name, preferred_language, role)
         VALUES (?, ?, 'es', ?)
         ON CONFLICT(email) DO NOTHING`,
      )
      .bind(email, displayName, role),
    ...defaultThreads.map((thread) =>
      db
        .prepare(
          `INSERT INTO thread_members (thread_id, user_email)
           SELECT id, ? FROM threads WHERE id = ? AND kind = ?
           ON CONFLICT(thread_id, user_email) DO NOTHING`,
        )
        .bind(email, thread.id, thread.kind),
    ),
  ]);

  const persisted = await db
    .prepare(
      "SELECT display_name, preferred_language, role, active FROM profiles WHERE email = ? LIMIT 1",
    )
    .bind(email)
    .first<{
      display_name: string;
      preferred_language: SupportedLanguage;
      role: Actor["role"];
      active: number;
    }>();
  if (!persisted) throw new Error("Authorized profile could not be created");
  if (!persisted.active) {
    throw new AuthorizationError("This account has been deactivated");
  }
  return {
    email,
    displayName: persisted.display_name,
    preferredLanguage: persisted.preferred_language,
    role: persisted.role,
  };
}

function configuredDefaultThreads() {
  const threadIds = [
    ...new Set(
      (runtimeValue("NEWONE_DEFAULT_THREAD_IDS") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];

  return threadIds.map((id) => {
    if (!Object.hasOwn(DEFAULT_THREAD_CATALOG, id)) {
      throw new AuthorizationError("Default conversation configuration is invalid");
    }
    const definition = DEFAULT_THREAD_CATALOG[id as keyof typeof DEFAULT_THREAD_CATALOG];
    return { id, ...definition };
  });
}

export function isDemoActor(actor: Actor): boolean {
  return actor.email.endsWith("@newone.demo");
}

function enforceAllowlist(email: string): void {
  const configured = runtimeValue("NEWONE_ALLOWED_EMAILS");
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new AuthorizationError("Company personnel access has not been configured");
    }
    return;
  }
  const allowed = new Set(
    configured.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );
  if (!allowed.has(email)) {
    throw new AuthorizationError("This account is not authorized for Newone Relay");
  }
}

function configuredEmails(name: string): Set<string> {
  return new Set(
    (runtimeValue(name) ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function roleForEmail(email: string): Actor["role"] {
  if (configuredEmails("NEWONE_ADMIN_EMAILS").has(email)) return "admin";
  if (configuredEmails("NEWONE_MANAGER_EMAILS").has(email)) return "manager";
  return "member";
}

function decodeName(requestHeaders: Headers): string | null {
  const value = requestHeaders.get("oai-authenticated-user-full-name");
  const encoding = requestHeaders.get("oai-authenticated-user-full-name-encoding");
  if (!value || encoding !== "percent-encoded-utf-8") return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
