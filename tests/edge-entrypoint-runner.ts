const name = Deno.env.get('NEWONE_COVERAGE_ENTRYPOINT') ?? '';
if (!/^newone-[a-z-]+$/.test(name)) throw new Error('Invalid Edge entrypoint name.');

setTimeout(() => Deno.exit(0), 1500);
await import(`../supabase/functions/${name}/index.ts`);
