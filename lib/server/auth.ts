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
    const role = roleForEmail(email);
    await db
      .prepare("INSERT INTO profiles (email, display_name, preferred_language, role) VALUES (?, ?, ?, ?)")
      .bind(email, name, "es", role)
      .run();
    await provisionDefaultMemberships(email);
    return { email, displayName: name, preferredLanguage: "es", role };
  }

  return {
    email,
    displayName: existing.display_name,
    preferredLanguage: existing.preferred_language,
    role: existing.role,
  };
}

async function provisionDefaultMemberships(email: string): Promise<void> {
  const threadIds = (runtimeValue("NEWONE_DEFAULT_THREAD_IDS") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (threadIds.length === 0) return;
  await getD1().batch(
    threadIds.map((threadId) =>
      getD1()
        .prepare(
          `INSERT OR IGNORE INTO thread_members (thread_id, user_email)
           SELECT id, ? FROM threads WHERE id = ?`,
        )
        .bind(email, threadId),
    ),
  );
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
