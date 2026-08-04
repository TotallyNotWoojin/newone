const projectUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
const expectPhone = process.env.NEWONE_EXPECT_PHONE_AUTH === 'true';

if (!projectUrl || !publishableKey) {
  console.error(
    'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required.',
  );
  process.exit(2);
}

let origin;
try {
  const parsed = new URL(projectUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
  origin = parsed.origin;
} catch {
  console.error('EXPO_PUBLIC_SUPABASE_URL must be a credential-free HTTPS origin.');
  process.exit(2);
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
let response;
try {
  response = await fetch(`${origin}/auth/v1/settings`, {
    signal: controller.signal,
    headers: { apikey: publishableKey },
  });
} catch (error) {
  console.error(`Hosted Auth settings request failed: ${error instanceof Error ? error.name : 'error'}`);
  process.exit(1);
} finally {
  clearTimeout(timeout);
}

if (!response.ok) {
  console.error(`Hosted Auth settings request returned HTTP ${response.status}.`);
  process.exit(1);
}

const settings = await response.json();
const failures = [];
if (settings?.disable_signup !== true) failures.push('open signup is enabled');
if (settings?.external?.anonymous_users !== false) failures.push('anonymous Auth is enabled');
if (settings?.external?.email !== true) failures.push('verified email Auth is disabled');
if (settings?.external?.phone !== expectPhone) {
  failures.push(`phone Auth does not match expected=${String(expectPhone)}`);
}

if (failures.length > 0) {
  console.error(`Hosted Auth public-settings gate failed: ${failures.join('; ')}.`);
  process.exit(1);
}

console.log(
  `Hosted Auth public-settings gate passed for ${new URL(origin).hostname}: signup=closed, anonymous=off, email=on, phone=${expectPhone ? 'on' : 'off'}.`,
);
console.log(
  'CAPTCHA, rate limits, hooks, redirects, and provider delivery require separate authenticated configuration evidence.',
);
