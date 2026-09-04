// Real disposable inbox (Guerrilla Mail public API). Codes are read from the
// actual email body, exactly as run-signup.mjs does — never from an admin API.
const GUERRILLA = 'https://api.guerrillamail.com/ajax.php';

async function call(params) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${GUERRILLA}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) return await response.json();
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error('mailbox API unavailable');
}

export async function createMailbox() {
  const inbox = await call({ f: 'get_email_address', lang: 'en' });
  if (!inbox.email_addr || !inbox.sid_token) throw new Error('could not obtain a disposable mailbox');
  return { email: inbox.email_addr, sid: inbox.sid_token, seen: new Set() };
}

// Waits for a six-digit code that has not been seen before in this mailbox.
export async function waitForCode(mailbox, { timeoutMs = 150_000, intervalMs = 6_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const list = await call({ f: 'get_email_list', offset: 0, sid_token: mailbox.sid });
    for (const message of list.list ?? []) {
      if (mailbox.seen.has(message.mail_id)) continue;
      const full = await call({ f: 'fetch_email', email_id: message.mail_id, sid_token: mailbox.sid });
      const text = `${full.mail_subject ?? ''} ${full.mail_body ?? ''}`.replace(/<[^>]+>/g, ' ');
      const match = text.match(/\b(\d{6})\b/);
      mailbox.seen.add(message.mail_id);
      if (match) return { code: match[1], subject: full.mail_subject ?? '', receivedAt: new Date().toISOString() };
    }
  }
  return null;
}

// Minted codes: when the project sinks mail for the throwaway domains
// (NEWONE_TEST_MAIL_SINK_DOMAINS on the server) and NEWONE_DEVICE_MINT_CODES=1
// here, the code comes from the auth admin API instead of the inbox. The app
// verifies it exactly as it verifies an emailed code. Used on Sep 4 2026 when
// the mail provider's daily quota was spent; the inbox path stays the default.
export function mintingEnabled() {
  return process.env.NEWONE_DEVICE_MINT_CODES === '1';
}

export async function mintCode(email) {
  const { loadAccessToken } = await import('../../hosted/smoke-lib.mjs');
  const { EXPECTED_PROJECT_REF } = await import('../../hosted/lib.mjs');
  const token = loadAccessToken();
  const keys = await (await fetch(`https://api.supabase.com/v1/projects/${EXPECTED_PROJECT_REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const service = keys.find((key) => key.name === 'service_role')?.api_key;
  const response = await fetch(`https://${EXPECTED_PROJECT_REF}.supabase.co/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const body = await response.json().catch(() => ({}));
  const code = String(body.email_otp ?? body.properties?.email_otp ?? '');
  if (!/^[0-9]{6}$/.test(code)) throw new Error(`could not mint a code for ${email} (${response.status})`);
  return { code, subject: 'minted via auth admin API (mail sink)', receivedAt: new Date().toISOString() };
}
