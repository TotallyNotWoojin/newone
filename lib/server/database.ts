import { workerBindings } from "./bindings";

let initialized = false;
let initialization: Promise<void> | null = null;

export function getD1(): D1Database {
  const binding = workerBindings().DB as D1Database | undefined;
  if (!binding) {
    throw new Error("Cloudflare D1 binding DB is unavailable");
  }
  return binding;
}

export async function ensureDatabase(): Promise<void> {
  if (initialized) return;
  if (initialization) return initialization;

  initialization = initializeDatabase().catch((error) => {
    initialization = null;
    throw error;
  });
  await initialization;
  initialized = true;
}

async function initializeDatabase(): Promise<void> {
  const db = getD1();
  if (process.env.NODE_ENV === "production") {
    await db.prepare("SELECT 1 FROM profiles LIMIT 1").first();
    return;
  }
  const statements = [
    `CREATE TABLE IF NOT EXISTS profiles (
      email TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      preferred_language TEXT NOT NULL DEFAULT 'es' CHECK(preferred_language IN ('ko', 'es')),
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member', 'manager', 'admin')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'operations',
      location TEXT NOT NULL DEFAULT '',
      shift_key TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS thread_members (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_email TEXT NOT NULL REFERENCES profiles(email) ON DELETE CASCADE,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(thread_id, user_email)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      client_message_id TEXT NOT NULL,
      sender_email TEXT NOT NULL REFERENCES profiles(email),
      sender_name TEXT NOT NULL,
      source_text TEXT NOT NULL,
      source_language TEXT NOT NULL CHECK(source_language IN ('ko', 'es')),
      target_language TEXT NOT NULL CHECK(target_language IN ('ko', 'es')),
      translated_text TEXT,
      detected_language TEXT,
      translation_warning TEXT,
      translation_status TEXT NOT NULL DEFAULT 'pending' CHECK(translation_status IN ('pending', 'translating', 'translated', 'retryable_failed', 'permanent_failed')),
      translation_started_at TEXT,
      message_kind TEXT NOT NULL DEFAULT 'message' CHECK(message_kind IN ('message', 'safety', 'production', 'maintenance', 'quality', 'handoff', 'instruction')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal', 'important', 'safety')),
      delivery_status TEXT NOT NULL DEFAULT 'delivered',
      human_reviewed INTEGER NOT NULL DEFAULT 0,
      provider TEXT,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      translated_at TEXT,
      UNIQUE(sender_email, client_message_id)
    )`,
    `CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      headline_ko TEXT NOT NULL,
      headline_es TEXT NOT NULL,
      summary_ko TEXT NOT NULL,
      summary_es TEXT NOT NULL,
      source_message_ids TEXT NOT NULL DEFAULT '[]',
      generated_by TEXT NOT NULL DEFAULT 'demo',
      model TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS action_items (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      title_ko TEXT NOT NULL,
      title_es TEXT NOT NULL,
      owner TEXT,
      due_label TEXT,
      status TEXT NOT NULL DEFAULT 'needs_confirmation' CHECK(status IN ('needs_confirmation', 'open', 'done')),
      source_message_id TEXT REFERENCES messages(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS summary_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      source_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'complete', 'failed')),
      summary_id TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      UNIQUE(thread_id, source_fingerprint)
    )`,
    `CREATE TABLE IF NOT EXISTS action_events (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      actor_email TEXT NOT NULL REFERENCES profiles(email),
      previous_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    "CREATE INDEX IF NOT EXISTS messages_thread_created_idx ON messages(thread_id, created_at, id)",
    "CREATE INDEX IF NOT EXISTS messages_search_idx ON messages(thread_id, source_text, translated_text)",
    "CREATE INDEX IF NOT EXISTS actions_thread_status_idx ON action_items(thread_id, status)",
    "CREATE INDEX IF NOT EXISTS action_events_action_created_idx ON action_events(action_id, created_at)",
  ];

  await db.batch(statements.map((statement) => db.prepare(statement)));
  await seedDemoWorkspace(db);
}

async function seedDemoWorkspace(db: D1Database): Promise<void> {
  const seeded = await db
    .prepare("SELECT id FROM threads WHERE id = ? LIMIT 1")
    .bind("shift-line-2")
    .first();
  if (seeded) return;

  const inserts = [
    db.prepare("INSERT OR IGNORE INTO profiles (email, display_name, preferred_language, role) VALUES (?, ?, ?, ?)").bind("jiyoon@newone.demo", "김지윤 · Jiyoon", "ko", "manager"),
    db.prepare("INSERT OR IGNORE INTO profiles (email, display_name, preferred_language, role) VALUES (?, ?, ?, ?)").bind("carlos@newone.demo", "Carlos Méndez", "es", "member"),
    db.prepare("INSERT OR IGNORE INTO profiles (email, display_name, preferred_language, role) VALUES (?, ?, ?, ?)").bind("sofia@newone.demo", "Sofía Ruiz", "es", "member"),
    db.prepare("INSERT INTO threads (id, title, subtitle, kind, location, shift_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("shift-line-2", "Line 2 · Morning shift", "2호 라인 · Turno de mañana", "shift", "Galvanizing floor", "2026-07-27-am", "2026-07-27T09:42:00-07:00"),
    db.prepare("INSERT INTO threads (id, title, subtitle, kind, location, shift_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("maintenance", "Maintenance", "정비 · Mantenimiento", "maintenance", "Plant-wide", null, "2026-07-27T09:18:00-07:00"),
    db.prepare("INSERT INTO threads (id, title, subtitle, kind, location, shift_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("quality", "Quality & coating", "품질 · Calidad", "quality", "Inspection bay", null, "2026-07-27T08:51:00-07:00"),
    db.prepare("INSERT INTO threads (id, title, subtitle, kind, location, shift_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("general", "General operations", "운영 공지 · Operaciones", "operations", "Plant-wide", null, "2026-07-26T16:25:00-07:00"),
    db.prepare("INSERT INTO thread_members (thread_id, user_email) VALUES (?, ?)").bind("shift-line-2", "jiyoon@newone.demo"),
    db.prepare("INSERT INTO thread_members (thread_id, user_email) VALUES (?, ?)").bind("maintenance", "jiyoon@newone.demo"),
    db.prepare("INSERT INTO thread_members (thread_id, user_email) VALUES (?, ?)").bind("quality", "jiyoon@newone.demo"),
    db.prepare("INSERT INTO thread_members (thread_id, user_email) VALUES (?, ?)").bind("general", "jiyoon@newone.demo"),
    db.prepare(`INSERT INTO messages (id, thread_id, client_message_id, sender_email, sender_name, source_text, source_language, target_language, translated_text, translation_status, message_kind, priority, delivery_status, human_reviewed, provider, model, created_at, translated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind("msg-001", "shift-line-2", "seed-001", "jiyoon@newone.demo", "김지윤 · Jiyoon", "오늘 2호 라인은 오전 10시에 아연 욕조 온도를 다시 확인해 주세요.", "ko", "es", "Hoy, vuelvan a revisar la temperatura del baño de zinc de la Línea 2 a las 10:00 a. m.", "translated", "instruction", "important", "read", 1, "seeded", "human-reviewed", "2026-07-27T08:07:00-07:00", "2026-07-27T08:07:02-07:00"),
    db.prepare(`INSERT INTO messages (id, thread_id, client_message_id, sender_email, sender_name, source_text, source_language, target_language, translated_text, translation_status, message_kind, priority, delivery_status, human_reviewed, provider, model, created_at, translated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind("msg-002", "shift-line-2", "seed-002", "carlos@newone.demo", "Carlos Méndez", "Entendido. La temperatura está en 447 °C y la volveré a medir a las 10.", "es", "ko", "확인했습니다. 현재 온도는 447°C이며 오전 10시에 다시 측정하겠습니다.", "translated", "message", "normal", "read", 1, "seeded", "human-reviewed", "2026-07-27T08:09:00-07:00", "2026-07-27T08:09:02-07:00"),
    db.prepare(`INSERT INTO messages (id, thread_id, client_message_id, sender_email, sender_name, source_text, source_language, target_language, translated_text, translation_status, message_kind, priority, delivery_status, human_reviewed, provider, model, created_at, translated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind("msg-003", "shift-line-2", "seed-003", "sofia@newone.demo", "Sofía Ruiz", "Hay una fuga pequeña cerca de la válvula B-14. Cerré el área y avisé a mantenimiento.", "es", "ko", "B-14 밸브 근처에 작은 누출이 있습니다. 구역을 통제했고 정비팀에 알렸습니다.", "translated", "safety", "safety", "read", 1, "seeded", "human-reviewed", "2026-07-27T08:46:00-07:00", "2026-07-27T08:46:02-07:00"),
    db.prepare(`INSERT INTO messages (id, thread_id, client_message_id, sender_email, sender_name, source_text, source_language, target_language, translated_text, translation_status, message_kind, priority, delivery_status, human_reviewed, provider, model, created_at, translated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind("msg-004", "shift-line-2", "seed-004", "jiyoon@newone.demo", "김지윤 · Jiyoon", "잘했습니다. B-14는 정비팀이 확인할 때까지 사용하지 마세요. 긴급 위험은 무전기로도 보고해 주세요.", "ko", "es", "Bien hecho. No usen la B-14 hasta que mantenimiento la revise. Informen también cualquier peligro urgente por radio.", "translated", "safety", "safety", "read", 1, "seeded", "human-reviewed", "2026-07-27T08:49:00-07:00", "2026-07-27T08:49:02-07:00"),
    db.prepare(`INSERT INTO messages (id, thread_id, client_message_id, sender_email, sender_name, source_text, source_language, target_language, translated_text, translation_status, message_kind, priority, delivery_status, human_reviewed, provider, model, created_at, translated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind("msg-005", "shift-line-2", "seed-005", "carlos@newone.demo", "Carlos Méndez", "Mantenimiento llegará a las 9:30. Mientras tanto, la Línea 2 sigue operando con la válvula aislada.", "es", "ko", "정비팀은 오전 9시 30분에 도착합니다. 그동안 2호 라인은 밸브를 격리한 상태로 계속 가동합니다.", "translated", "maintenance", "important", "delivered", 0, "seeded", "human-reviewed", "2026-07-27T09:04:00-07:00", "2026-07-27T09:04:02-07:00"),
    db.prepare(`INSERT INTO messages (id, thread_id, client_message_id, sender_email, sender_name, source_text, source_language, target_language, translated_text, translation_status, message_kind, priority, delivery_status, human_reviewed, provider, model, created_at, translated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind("msg-006", "maintenance", "seed-006", "sofia@newone.demo", "Sofía Ruiz", "La bomba de recirculación hace un ruido intermitente desde las 9:05.", "es", "ko", "순환 펌프에서 오전 9시 5분부터 간헐적인 소음이 발생합니다.", "translated", "maintenance", "important", "delivered", 0, "seeded", "human-reviewed", "2026-07-27T09:18:00-07:00", "2026-07-27T09:18:02-07:00"),
    db.prepare(`INSERT INTO messages (id, thread_id, client_message_id, sender_email, sender_name, source_text, source_language, target_language, translated_text, translation_status, message_kind, priority, delivery_status, human_reviewed, provider, model, created_at, translated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind("msg-007", "quality", "seed-007", "carlos@newone.demo", "Carlos Méndez", "La muestra 27-B tiene una zona sin recubrimiento en el borde inferior.", "es", "ko", "샘플 27-B의 아래쪽 가장자리에 도금되지 않은 부분이 있습니다.", "translated", "quality", "important", "read", 1, "seeded", "human-reviewed", "2026-07-27T08:51:00-07:00", "2026-07-27T08:51:02-07:00"),
    db.prepare(`INSERT INTO summaries (id, thread_id, headline_ko, headline_es, summary_ko, summary_es, source_message_ids, generated_by, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind("summary-shift-1", "shift-line-2", "B-14 밸브 격리, 정비 확인 대기", "Válvula B-14 aislada; pendiente revisión", "B-14 밸브 근처의 작은 누출로 구역을 통제했고 밸브를 격리했습니다. 정비팀은 오전 9시 30분에 도착할 예정입니다. 2호 라인의 아연 욕조 온도는 오전 10시에 다시 확인해야 합니다.", "Se aisló la válvula B-14 y se cerró el área por una fuga pequeña. Mantenimiento llegará a las 9:30. La temperatura del baño de zinc de la Línea 2 debe verificarse otra vez a las 10:00.", JSON.stringify(["msg-001", "msg-003", "msg-004", "msg-005"]), "demo", "human-reviewed-demo", "2026-07-27T09:12:00-07:00"),
    db.prepare(`INSERT INTO action_items (id, thread_id, title_ko, title_es, owner, due_label, status, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind("action-001", "shift-line-2", "B-14 밸브 누출 점검", "Revisar la fuga de la válvula B-14", "Maintenance", "9:30 AM", "open", "msg-003", "2026-07-27T09:12:00-07:00"),
    db.prepare(`INSERT INTO action_items (id, thread_id, title_ko, title_es, owner, due_label, status, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind("action-002", "shift-line-2", "아연 욕조 온도 재확인", "Volver a medir la temperatura del baño", "Carlos", "10:00 AM", "open", "msg-001", "2026-07-27T09:12:00-07:00"),
  ];

  await db.batch(inserts);
}
