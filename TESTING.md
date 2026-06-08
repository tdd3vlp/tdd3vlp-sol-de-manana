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
| `db-helpers.test.ts` | `getOrCreateChat`, `saveMessage`, `getRecentMessages`, `updateChatTheme`, `resetChat` — all with mocked Prisma |
| `prompt-assembly.test.ts` | System prompt contains the current theme, all language rules, reminder text, and schema field names |
| `formatting.test.ts` | `shouldChangeTheme` boundary cases (count < 4 = false, count ≥ 8 = true), fixture helpers |
| `language-behavior.test.ts` | All 5 language input paths (Spanish, Russian, mixed, unsupported, nonsense + too-short) with mocked LLM; retry on first failure; SolServiceError after two failures |
| `nonsense.test.ts` | Nonsense path produces a warning, no correction, no question; assembled message has no bold markers |
| `bot-handlers.test.ts` | `assembleMessage` part order, `formatForTelegram` HTML conversion and escaping, `handleStart` (reset + LLM call + fallback), `handleMessage` (user message save, theme count increment, theme change at count ≥ 4–8, LLM fallback) |

## What Is Not Covered by Automated Tests

- Real correction quality: whether the LLM actually fixes Spanish grammar correctly
- Real translation quality: whether Russian → Spanish translations are accurate
- Telegram delivery: messages are tested via mocked `ctx.reply`

Manual end-to-end testing with a real bot token and OpenAI key is required to validate conversation quality.
