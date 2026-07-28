import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const LOCAL_RUNTIME_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_TRANSLATION_MODEL",
  "OPENROUTER_SUMMARY_MODEL",
  "OPENROUTER_PROVIDER",
  "NEWONE_AI_DATA_EGRESS_APPROVED",
  "NEWONE_APP_URL",
  "NEWONE_ALLOWED_EMAILS",
  "NEWONE_MANAGER_EMAILS",
  "NEWONE_ADMIN_EMAILS",
  "NEWONE_DEFAULT_THREAD_IDS",
] as const;

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ command, mode }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const localEnvironment = command === "serve" ? loadEnv(mode, process.cwd(), "") : {};
  const localRuntimeVars = Object.fromEntries(
    LOCAL_RUNTIME_KEYS.flatMap((key) => {
      const value = process.env[key] ?? localEnvironment[key];
      return value ? [[key, value]] : [];
    }),
  );

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: {
          ...localBindingConfig,
          ...(command === "serve" ? { vars: localRuntimeVars } : {}),
        },
      }),
    ],
  };
});
