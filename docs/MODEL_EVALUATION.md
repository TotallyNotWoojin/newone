# OpenRouter and Qwen model decision

Research refreshed: August 3, 2026. Prices and endpoint availability can change, so the release check must query the live catalog and ZDR endpoint API again before purchase or deployment.

## Evaluation baseline, not production approval

`qwen/qwen3-235b-a22b-2507` on the exact `google-vertex/us-south1` endpoint is the first evaluation baseline for translation and summaries. No model is approved for employee data yet.

This is a privacy-first choice. It combines low token cost, strict structured-output support, multiple-provider availability, a versioned model ID, and an exact US Vertex endpoint that appeared on OpenRouter’s live ZDR list during research. The app does not silently fall back if that endpoint is unavailable.

The live catalog's lowest advertised route is approximately $0.09 per million input tokens and $0.55 per million output tokens, but that is not the cost of the selected privacy route. On August 3, the ZDR API listed the structured-output-capable Google `google-vertex/us-south1` route at about $0.22 per million input tokens and $0.88 per million output tokens, with roughly 99.88% reported one-day uptime at the time of the snapshot. A short 300-input/200-output request is roughly $0.000242 in raw inference, so 10,000 such requests are about $2.42 before retries, tokenizer differences, OpenRouter fees, or price changes. Verify the current [OpenRouter model catalog](https://openrouter.ai/models), [live ZDR endpoints](https://openrouter.ai/api/v1/endpoints/zdr), and [billing FAQ](https://openrouter.ai/docs/faq).

## Strong alternatives

| Route | Catalog price per 1M input/output | Live ZDR endpoints | Use |
|---|---:|---:|---|
| `qwen/qwen3.6-35b-a3b` | catalog about $0.14 / $1.00; a current ZDR route advertised about $0.10 / $0.95 | Yes | Primary cost/latency challenger; must beat the baseline on Korean-Spanish safety cases and pass provider/region review |
| `qwen/qwen3.5-122b-a10b` | about $0.26 / $2.08 | Yes | Larger summary and translation challenger |
| `qwen/qwen3.5-397b-a17b` | about $0.39 / $2.34 | Yes | High-capability open-weight challenger where latency permits |
| `qwen/qwen3-32b` | a current ZDR route advertised about $0.08 / $0.28 | Yes | Budget challenger; quality and route review remain mandatory |
| `qwen/qwen3.5-9b` | about $0.10 / $0.15 | Yes | Extreme-budget canary; not a production default without unusually strong golden-set evidence |
| `qwen/qwen3.5-flash-02-23` | about $0.065 / $0.26 | No at refresh | Cheap/fast but disqualified for employee data unless an approved ZDR endpoint appears |
| `qwen/qwen3.7-flash` | about $0.03 / $0.13 below 32K | No at refresh | Synthetic-data canary only; disqualified for employee data at this review |
| `qwen/qwen3.8-max` | about $2.00 / $6.00 | No at refresh | Newly released flagship; expensive and disqualified for employee data until an approved ZDR route appears |

Qwen officially lists Korean and Spanish among Qwen3.5’s 201 languages and publishes strong aggregate multilingual translation scores. That is useful evidence, but it is not a Korean ↔ Spanish galvanizing-plant benchmark. See the [Qwen3.5 announcement](https://qwen.ai/blog?id=qwen3.5) and [official model card](https://huggingface.co/Qwen/Qwen3.5-35B-A3B).

Qwen-MT is a dedicated direct Alibaba translation API with terminology intervention, domain prompting, and translation memory. It was not available through OpenRouter during research, so adopting it would add a separate direct-provider integration. See the [Qwen-MT announcement](https://qwenlm.github.io/blog/qwen-mt/).

## Required golden-set evaluation

Do not approve a model based on aggregate benchmark scores. Build a deidentified set reviewed by Korean and Spanish workplace experts. Include at least:

- Korean honorific/register choices and omitted subjects
- Mexican/US workplace Spanish and code-switching
- names, handles, abbreviations, emoji, and formatting
- equipment IDs such as B-14, C-22, sample 27-B
- temperatures, pressure, dimensions, tolerances, dates, and times
- negation and meaning-reversal traps
- safety urgency without added or softened instructions
- ambiguity that should generate a warning
- short messages where automatic language detection is weak
- shift-summary source attribution and action-owner hallucination traps

Blind reviewers to the model. Score semantic accuracy, terminology, tone/register, number/unit preservation, harmful reversal rate, ambiguity signaling, p50/p95 latency, failure rate, structured-output validity, and cost.

Production criteria should include zero critical safety reversals in the release set, 100% preservation of IDs/numbers/units, valid source IDs for every generated action, and a documented human-review threshold. The Company should choose the exact thresholds and sign off on them.

## Current synthetic smoke evidence

On August 3, 2026, the exact baseline route completed the repository's initial eight-case synthetic Korean-Spanish smoke set. The first pass scored 7/8: it preserved the meaning but reformatted `±0.25 mm` and `0.30 mm`, correctly failing the byte-exact number/unit invariant. A second full pass that supplied extracted values as protected tokens passed 8/8. Across that second pass the API reported 1,023 prompt tokens and 763 completion tokens.

The gate was then expanded to 20 synthetic cases covering double negation, ranges, decimal commas, dates, mentions, line breaks, quoted prompt injection, emergency and payroll review boundaries, Unicode equipment IDs, diacritics, and ambiguous pronouns. The expanded run passed 20/20 on the same pinned model and exact provider route, reporting 2,613 prompt tokens and 1,982 completion tokens. This remains synthetic engineering evidence, not bilingual-human approval.

The exact production adapter was also exercised against that pinned route with a separate synthetic Korean-to-Spanish request on August 3. That smoke covered the deployed adapter's fail-closed policy parser, provider-only routing, price ceiling, ZDR and data-denial request fields, strict response schema, source hash, provenance, and deterministic protected-token restoration. It passed with three protected spans restored and API-reported usage of 197 prompt tokens and 144 completion tokens. This closes an integration gap in the earlier evaluator, but still does not replace human bilingual review.

That result is evidence for a required engineering control, not model approval. The production adapter must extract identifiers, numbers, units, temperatures, and times, replace or explicitly protect them before inference, restore them deterministically, and reject or flag any output that fails the invariant. Prompting alone is not the security boundary. The synthetic set is in `evals/translation-golden.synthetic.json`; the paid runner is `scripts/run-openrouter-language-eval.mjs` and never accepts employee fixtures.

## Credentials and billing

OpenRouter requires its own API key and credits. ChatGPT Pro does not include them. Keep keys server-side, separated by environment, spend-limited, and rotated under Company control.
