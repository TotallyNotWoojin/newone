import { readFile } from 'node:fs/promises';

const policyUrl = new URL('../config/ai-route-policy.json', import.meta.url);
const policy = JSON.parse(await readFile(policyUrl, 'utf8'));

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

requireValue(typeof policy.policyVersion === 'string', 'AI policy version is missing.');
requireValue(typeof policy.model === 'string', 'AI policy model is missing.');
requireValue(typeof policy.providerTag === 'string', 'AI policy provider tag is missing.');
requireValue(
  typeof policy.providerMetadataName === 'string',
  'AI policy provider metadata name is missing.',
);
requireValue(policy.requirements?.zeroDataRetention === true, 'AI policy must require ZDR.');
requireValue(policy.requirements?.structuredOutputs === true, 'AI policy must require structured output.');
requireValue(policy.requirements?.responseFormat === true, 'AI policy must require response_format.');
requireValue(policy.requirements?.allowFallbacks === false, 'AI policy must disable fallbacks.');
requireValue(policy.requirements?.dataCollection === 'deny', 'AI policy must deny data collection.');
requireValue(policy.requirements?.cache === false, 'AI policy must disable cache.');
requireValue(
  policy.requirements?.implicitCaching === false,
  'AI policy must reject provider implicit caching.',
);
requireValue(
  policy.requirements?.bringYourOwnKeys === false,
  'AI policy must reject OpenRouter BYOK routing.',
);
requireValue(
  policy.requirements?.managementControlPlanePreflight === true,
  'AI policy must require a management control-plane preflight.',
);
requireValue(
  policy.requirements?.syntheticRouteProbe === true,
  'AI policy must require a synthetic pre-egress route probe.',
);
requireValue(policy.requirements?.plugins === false, 'AI policy must disable plugins.');
requireValue(policy.requirements?.webSearch === false, 'AI policy must disable web search.');
requireValue(policy.requirements?.tools === false, 'AI policy must disable tools.');

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);

let endpointResponse;
let providerResponse;
try {
  [endpointResponse, providerResponse] = await Promise.all([
    fetch('https://openrouter.ai/api/v1/endpoints/zdr', {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    }),
    fetch('https://openrouter.ai/api/v1/providers', {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    }),
  ]);
} finally {
  clearTimeout(timeout);
}

requireValue(
  endpointResponse.ok,
  `OpenRouter ZDR endpoint returned HTTP ${endpointResponse.status}.`,
);
requireValue(
  providerResponse.ok,
  `OpenRouter providers endpoint returned HTTP ${providerResponse.status}.`,
);
const [payload, providerPayload] = await Promise.all([
  endpointResponse.json(),
  providerResponse.json(),
]);
requireValue(Array.isArray(payload.data), 'OpenRouter ZDR response shape changed.');
requireValue(Array.isArray(providerPayload.data), 'OpenRouter providers response shape changed.');

const baseProviderSlug = policy.providerTag.split('/')[0];
const providerCatalogMatches = providerPayload.data.filter(
  (provider) => provider?.slug === baseProviderSlug,
);
requireValue(
  providerCatalogMatches.length === 1 &&
    providerCatalogMatches[0]?.name === policy.providerMetadataName,
  `Provider metadata name does not match the live ${baseProviderSlug} catalog entry.`,
);

const eligible = payload.data.filter((endpoint) => {
  const supported = Array.isArray(endpoint.supported_parameters)
    ? endpoint.supported_parameters
    : [];
  return (
    endpoint.model_id === policy.model &&
    endpoint.tag === policy.providerTag &&
    endpoint.provider_name === policy.providerMetadataName &&
    endpoint.status === 0 &&
    endpoint.supports_implicit_caching === false &&
    supported.includes('structured_outputs') &&
    supported.includes('response_format')
  );
});

requireValue(
  eligible.length > 0,
  `No healthy structured-output ZDR route matches ${policy.model} on ${policy.providerTag}.`,
);

const withinCeiling = eligible.some((endpoint) => {
  const prompt = Number(endpoint.pricing?.prompt) * 1_000_000;
  const completion = Number(endpoint.pricing?.completion) * 1_000_000;
  return (
    Number.isFinite(prompt) &&
    Number.isFinite(completion) &&
    prompt <= policy.priceCeilingsUsdPerMillionTokens.prompt &&
    completion <= policy.priceCeilingsUsdPerMillionTokens.completion
  );
});

requireValue(
  withinCeiling,
  `The approved ZDR route exceeds policy price ceilings for ${policy.model}.`,
);

console.log(
  `AI route policy ${policy.policyVersion} verified: ${policy.model} on ${policy.providerTag}; employee egress enabled=${policy.employeeDataEgressEnabled}.`,
);
