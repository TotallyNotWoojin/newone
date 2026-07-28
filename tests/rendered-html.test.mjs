import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = 32_000 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
let server;
let serverOutput = "";

before(async () => {
  server = spawn(
    fileURLToPath(new URL("../node_modules/.bin/vinext", import.meta.url)),
    ["start", "--port", String(port), "--hostname", "127.0.0.1"],
    { cwd: root, env: { ...process.env, NODE_ENV: "production" } },
  );
  server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Production server exited early:\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Production server did not become ready:\n${serverOutput}`);
});

after(() => {
  if (server?.exitCode === null) server.kill("SIGTERM");
});

function request(path = "/", init = {}) {
  return fetch(`${origin}${path}`, init);
}

test("server-renders the private Newone Relay sign-in surface", async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const html = await response.text();
  assert.match(html, /<title>Newone Relay · Korean ↔ Spanish operations chat<\/title>/i);
  assert.match(html, /NEWONE RELAY/);
  assert.match(html, /Every shift/);
  assert.match(html, /Sign in to your workspace/);
  assert.match(html, /Access is limited to company-authorized accounts/);
  assert.doesNotMatch(html, /react-loading-skeleton|codex-preview|Your site is taking shape/);
});

test("health is public but protected APIs require identity in production", async () => {
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "private, no-store, max-age=0");
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.ai.configured, false);
  assert.equal(healthBody.ai.privacyMode, "zdr");

  const bootstrap = await request("/api/bootstrap");
  assert.equal(bootstrap.status, 401);
  assert.deepEqual(await bootstrap.json(), { error: "Sign in is required" });
});

test("starter preview artifacts and dependency are removed", async () => {
  const [packageJson, page, manifest] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
  ]);

  assert.match(packageJson, /"name": "newone-relay"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview|codex-preview/);
  assert.match(manifest, /"name": "Newone Relay"/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
