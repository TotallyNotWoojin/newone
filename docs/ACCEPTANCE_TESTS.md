# Acceptance test plan

## Automated checks

Run:

```bash
npm run typecheck
npm run lint
npm test
npm audit --omit=dev
```

`npm test` performs a production build, verifies the private sign-in surface and security headers, checks the public health response, confirms protected APIs require identity, and proves starter preview artifacts are gone.

## API acceptance

### Original-first delivery

- A valid authorized message returns 201.
- The stored source text is exact, `deliveryStatus=delivered`, and translation starts pending.
- Provider failure returns 503 for translation while the original remains delivered.
- Replaying the same client ID and identical payload returns 200 with the same message ID.
- Replaying the same client ID with different content/thread/language returns 409.
- Parallel translation requests result in one atomic `translating` claim.

### Validation

- Invalid/non-object/malformed JSON returns 400.
- A non-JSON content type returns 415.
- Unknown language, kind, or priority returns 400.
- Text over 2,000 characters and IDs over their limits return 400.
- Unauthorized/nonexistent conversation access returns 404 or 403 without revealing data.
- Unexpected errors return a generic 500 message.

### Search

- Spanish source, Korean source, translated text, person name, and equipment ID each return expected authorized results.
- One Hangul syllable can be searched.
- Latin queries shorter than two characters return no results.
- Query over 120 characters returns 400.
- Search uses POST so the query is not placed in the URL.

### Briefs and actions

- Member summary/action mutation returns 403.
- Manager summary with no configured/approved AI returns 503 and leaves the current brief unchanged.
- Concurrent identical summary requests make one model call and one action set.
- Every stored generated source ID belongs to the authorized message set.
- Every generated action begins `needs_confirmation` and has a source message.
- Action changes use compare-and-set behavior and append an `action_events` record.

### Authorization

- Production without `NEWONE_ALLOWED_EMAILS` fails closed.
- An allowlisted new user receives only configured default threads.
- An unknown configured default fails closed without creating the profile.
- Removing a membership persists across later requests.
- `active=0` blocks the account.
- No unauthenticated production demo actor exists.
- A caller-supplied identity header cannot bypass the trusted Sites ingress in the deployed environment.

## Product and bilingual review

- Incoming translation first and original second are correctly labeled.
- Sender sees the original first.
- Korean and Spanish `lang` attributes are present.
- Safety messages remain visually distinct and show the emergency-process reminder.
- Ambiguity/source-direction warnings are visible.
- Desktop three-column, tablet, and narrow mobile layouts remain usable.
- All primary controls are at least 44×44 CSS pixels on touch layouts.
- Keyboard focus is visible; Command/Ctrl+K and Escape work.
- Search dialog, live status, offline status, and errors are announced appropriately.
- Color is not the only source of safety/status meaning.
- A Korean/Spanish reviewer validates every golden-set translation and summary criterion in `MODEL_EVALUATION.md`.

## Current verified local results

As of July 27, 2026:

- clean TypeScript, ESLint, and production build;
- production dependency audit reports zero production vulnerabilities;
- D1 bootstrap returns four local demo threads and reviewed seed messages;
- message creation 201, exact replay 200, mismatched replay 409;
- no-key translation 503 with original preserved;
- bilingual/equipment search 200;
- invalid runtime types 400 and wrong content type 415;
- repeated no-key summary attempts recover their failed claim and return controlled 503;
- manager action status change and restoration 200 with audit events;
- an unassigned identity receives 403.

AI success and bilingual quality are intentionally not marked verified because no approved OpenRouter production key was provided. Manual visual browser QA remains required if an in-app browser is unavailable during engineering validation.
