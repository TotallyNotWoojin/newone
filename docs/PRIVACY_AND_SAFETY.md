# Privacy and safety release policy

## Current decision

The local demo is ready for product review with fictional data. Live employee data is blocked from AI egress by default.

Adding `OPENROUTER_API_KEY` alone does not enable AI. The Worker also requires `NEWONE_AI_DATA_EGRESS_APPROVED=true`. Treat that setting as a controlled production release action, not a developer convenience.

## Why approval is required

OpenRouter states that prompt/response logging is off by default and offers ZDR and data-collection routing controls. Its standard DPA also defines employment information as sensitive data and says sensitive data is not intended unless separately agreed. Its standard terms include suitability limitations for employment/customer-facing use. Review the current [data collection documentation](https://openrouter.ai/docs/guides/privacy/data-collection), [ZDR documentation](https://openrouter.ai/docs/guides/features/zdr), [DPA](https://openrouter.ai/data-processing-agreement), and [terms](https://openrouter.ai/terms) with Company counsel and security.

## Technical protections already enforced

Each model call includes:

```json
{
  "provider": {
    "only": ["google-vertex/us-south1"],
    "zdr": true,
    "data_collection": "deny",
    "require_parameters": true,
    "allow_fallbacks": false
  }
}
```

The Worker also sends `X-OpenRouter-Cache: false`, uses a versioned model ID, keeps the key server-side, sends no plugins/tools/web search, and does not intentionally log raw prompts. OpenRouter notes that request-level ZDR and response caching are separate controls, which is why both are set. See [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) and [response caching](https://openrouter.ai/docs/guides/features/response-caching).

Account-level ZDR must also be enabled and logging/discount opt-ins must remain off. Recheck the [live ZDR endpoint list](https://openrouter.ai/api/v1/endpoints/zdr) before release because endpoint policies can change.

## Required organizational controls

Before the approval flag becomes true:

1. Obtain written Company approval to transmit the defined message categories to the exact third parties.
2. Execute an enterprise agreement/DPA amendment that explicitly authorizes the employment data involved.
3. Record the approved model, endpoint slug, processing region, subprocessors, and fallback prohibition.
4. Review the current SOC 2 report, penetration test summary, incident terms, deletion schedule, metadata retention, and subprocessor notices.
5. Define transcript retention, deletion, legal hold, access review, offboarding, incident response, and data-subject request procedures.
6. Confirm the private Sites ingress is the only reachable origin and strips caller-supplied identity headers.
7. Complete a DPIA/privacy and labor/employee notice review where applicable.
8. Verify no health, immigration, union, disciplinary, payroll, or other specially protected content is permitted without the necessary additional agreements and policy.

For the highest-sensitivity use, call an approved regional Vertex AI or Bedrock endpoint directly. OpenRouter BYOK changes billing and provider-account control but does not remove OpenRouter from the data path.

## Human review policy

Relay is never the sole authority for emergency response or high-impact employment decisions. Preserve the original, show provenance, and require a qualified human to review safety, legal, disciplinary, medical, payroll, and other high-impact text.

Do not describe message delivery, translation completion, or a read indicator as proof of comprehension. Use teach-back or another approved confirmation process for critical instructions.

## Quality incidents

When a harmful or materially wrong translation is reported:

1. Stop relying on the translation and use an approved bilingual person or interpreter.
2. Preserve the original, translation, model, provider-region, timestamps, and source references.
3. Correct the operational record without overwriting the original evidence.
4. Classify whether numbers, units, negation, equipment IDs, urgency, or cultural/register errors were involved.
5. Add a deidentified regression case to the golden evaluation set.
6. Disable the model route if the error crosses the Company’s release threshold.
