# OpenRouter and Qwen model decision

Research date: July 27, 2026. Prices and endpoint availability can change, so verify them before purchase or deployment.

## Selected default

`qwen/qwen3-235b-a22b-2507` on the exact `google-vertex/us-south1` endpoint is the default for both translation and summaries.

This is a privacy-first choice. It combines low token cost, strict structured-output support, multiple-provider availability, a versioned model ID, and an exact US Vertex endpoint that appeared on OpenRouter’s live ZDR list during research. The app does not silently fall back if that endpoint is unavailable.

The model is approximately $0.09 per million input tokens and $0.55 per million output tokens at the researched base price. A short 300-input/200-output request is roughly $0.000137 in raw inference, so 10,000 such requests are about $1.37 before retries, tokenizer differences, OpenRouter fees, or price changes. Verify the current [OpenRouter model catalog](https://openrouter.ai/models) and [billing FAQ](https://openrouter.ai/docs/faq).

## Strong alternatives

| Route | Researched price per 1M input/output | Use |
|---|---:|---|
| `qwen/qwen3.5-122b-a10b` | $0.26 / $2.08 | Higher-quality summary challenger |
| `qwen/qwen3.5-flash-02-23` | $0.065 / $0.26 | Fast translation challenger; provider/privacy coverage must be rechecked |
| `qwen/qwen3-30b-a3b-instruct-2507` | about $0.048 / $0.193 promotional | Budget challenger |
| `qwen/qwen3.7-flash` | launched at $0.03 / $0.13 below 32K | Canary only; too new for production evidence at research time |

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

## Credentials and billing

OpenRouter requires its own API key and credits. ChatGPT Pro does not include them. Keep keys server-side, separated by environment, spend-limited, and rotated under Company control.
