# Testing

## Running Tests

```sh
npm test
```

No database or API keys needed — all tests mock external dependencies.

## Strategy

OpenAI is mocked at the `openaiClient` module level so no real API calls are made. The bot's language behavior is tested by stubbing the parsed LLM response and verifying that handlers, message assembly, and DB helpers behave correctly.

Prisma is mocked at the `prisma` module level so no database is needed for unit tests.

## Test Files

| File | What it covers |
|---|---|
| `db-helpers.test.ts` | `getOrCreateChat`, `saveMessages`, `getRecentMessages`, `saveTurn` (theme state + message pair in one transaction), `resetChat` — all with mocked Prisma |
| `prompt-assembly.test.ts` | `isKnownTheme`; system prompt contains the current theme, all language rules, reminder text, and schema field names |
| `formatting.test.ts` | `shouldChangeTheme` boundary cases (count < 4 = false, count ≥ 8 = true), `diffAndBold` correction bolding, bold stripping in continuations, bold formatting end-to-end for Spanish and mixed input, fixture helpers |
| `language-behavior.test.ts` | All language input paths (Spanish, Russian, mixed, unsupported) with mocked LLM; accent corrections; retry on first failure; SolServiceError after two failures |
| `nonsense.test.ts` | `isNonsense` pre-filter, semantic null-artifact validation; nonsense path produces a warning, no correction, no question; assembled message has no bold markers |
| `llm-context.test.ts` | `buildLLMContext` history trimming for the LLM prompt |
| `subscriptions.test.ts` | Plan limits and helpers (`PLAN_LIMITS`, `getPlanLimit`, `isAdminUser`, day-boundary helpers), `consumeDailyMessage` (expiry downgrade, daily reset, atomic limit check), `refundDailyMessage` |
| `bot-handlers.test.ts` | `assembleMessage` part order, `formatForTelegram` HTML conversion and escaping, `handleStart` (reset + LLM call + fallback), `handleMessage` (delivered-turn persistence via `saveTurn`, theme count increment, theme change at count ≥ 4–8, LLM fallback, refunds, no history on delivery failure), `handleSuccessfulPayment` (record + upgrade, duplicate charge), `handleUnsupportedMedia` |

## What Is Not Covered by Automated Tests

- Real correction quality: whether the LLM actually fixes Spanish grammar correctly
- Real translation quality: whether Russian → Spanish translations are accurate
- Telegram delivery: messages are tested via mocked `ctx.reply`

Manual end-to-end testing with a real bot token and OpenAI key is required to validate conversation quality.
