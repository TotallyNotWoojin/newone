import { sha256Hex } from '../supabase/functions/_shared/crypto.ts';
import {
  OpenRouterLanguageProcessor,
  parseOpenRouterPolicy,
} from '../supabase/functions/_shared/openrouter.ts';

const apiKey = Deno.env.get('OPENROUTER_API_KEY')?.trim();
if (!apiKey || apiKey.length < 20) {
  throw new Error('OPENROUTER_API_KEY is required for the paid synthetic adapter smoke.');
}

const policySource = JSON.parse(await Deno.readTextFile('config/ai-route-policy.json'));
const policy = parseOpenRouterPolicy(JSON.stringify({
  ...policySource,
  employeeDataEgressEnabled: true,
}));

const sourceBody = 'B-14의 압력을 2.5 bar로 유지하고 14:30에 lot MX-27을 다시 확인하세요.';
const sourceSha256 = await sha256Hex(sourceBody);
const processor = new OpenRouterLanguageProcessor({
  apiKey,
  dataClassification: 'synthetic',
  policy,
  siteUrl: 'https://newone.example',
  siteName: 'Newone production-adapter synthetic smoke',
});

const result = await processor.translate({
  sourceBody,
  sourceLanguage: 'ko',
  targetLanguage: 'es',
  sourceSha256,
  correlationId: crypto.randomUUID(),
});

for (const protectedValue of ['B-14', '2.5 bar', '14:30', 'MX-27']) {
  if (!result.translatedText.includes(protectedValue)) {
    throw new Error(`Production adapter failed to restore ${protectedValue}.`);
  }
}
if (
  result.model !== policy.model ||
  result.providerRoute !== policy.providerTag ||
  result.policyVersion !== policy.policyVersion ||
  result.sourceSha256 !== sourceSha256 ||
  result.invariantStatus !== 'passed'
) {
  throw new Error('Production adapter returned inconsistent provenance.');
}

console.log(
  `Production adapter smoke passed: model=${result.model}; route=${result.providerRoute}; ` +
    `protected=${result.protectedTokenCount}; promptTokens=${result.promptTokens ?? 'unknown'}; ` +
    `completionTokens=${result.completionTokens ?? 'unknown'}.`,
);
