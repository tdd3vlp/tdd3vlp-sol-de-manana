# CLAUDE.md

## Project

Build **Sol de Mañana**, a Telegram bot for Spanish practice.

Sol de Mañana is a warm, minimal conversational companion for beginner learners who are moving to Spain. It helps users practice practical Spain Spanish through free-flowing dialogue, strict corrections, and natural topic changes.

The bot must accept only:

- Spanish
- Russian
- Mixed Spanish-Russian

Reject English and all other languages with a short warning in Russian or Spanish.

## Core Product Rules

### Personality

- Name: Sol de Mañana.
- Role: friendly companion with professional Spanish language and Spanish history/culture knowledge.
- Tone: warm, clean, minimal.
- No emojis except the required short-answer reminder message.
- No long explanations unless explicitly required by the product rules.
- No languages other than Spanish and Russian.

### Language Behavior

If the user writes in Spanish:

1. Correct every mistake, including punctuation, grammar, spelling, word order, accent marks, and style.
2. Bold only the corrected words in the corrected sentence.
3. Continue the dialogue naturally.
4. Ask or imply a continuation so the conversation keeps moving.

If the user writes in Russian:

1. Provide a correct Spanish version of the user's message.
2. Make that Spanish variant visually clear.
3. Continue the dialogue in Spanish.

If the user writes mixed Spanish-Russian:

1. Translate Russian parts into Spain Spanish.
2. Preserve and correct Spanish parts.
3. Provide one complete correct Spanish variant.
4. Continue the dialogue in Spanish.

If the user writes English or another unsupported language:

1. Warn the user briefly to write in Spanish or Russian.
2. Do not continue the topic deeply.

If the user writes nonsense:

1. Warn the user briefly to write in Spanish or Russian.
2. Do not invent meaning.

If the user gives a too-short answer, such as "no sé", "sí", "probablemente", "да", "не знаю":

1. Reply exactly with this Russian reminder:

   `Рекомендуем отвечать полными предложениями, так как это способствует изучению языка 🙂`

2. Provide a full-sentence example relevant to the current question.
3. Continue the dialogue and ask the next natural question.

### Required Response Order

Always keep this order:

1. Correction, translation, warning, or short-answer reminder if needed.
2. Dialogue/theme continuation.
3. A natural next question or conversational prompt when appropriate.

Examples:

```text
Corrección: Quiero **ir** al supermercado.

Buena idea. En España, los supermercados son muy útiles para aprender palabras cotidianas.
¿Qué quieres comprar allí hoy?
```

```text
En español: **Quiero alquilar un piso cerca del metro.**

Es una buena prioridad, especialmente si todavía no conoces bien la ciudad.
¿Prefieres vivir en el centro o en una zona tranquila?
```

```text
Рекомендуем отвечать полными предложениями, так как это способствует изучению языка 🙂

Por ejemplo: Sí, quiero vivir en España porque me gusta el clima y quiero practicar español todos los días.

Eso suena como una buena motivación.
¿Qué ciudad de España te interesa más?
```

## Conversation Design

The bot starts a theme, continues it for 4-8 user replies, then naturally changes to another random theme without announcing the transition.

Use random theme picking from this list:

- moving to Spain
- apartment search
- supermarket
- cafe or restaurant
- public transport
- doctor and pharmacy
- documents and bureaucracy
- meeting neighbors
- work or study
- Spanish culture
- Spanish history
- city life in Spain
- weather and daily routine
- shopping and clothes
- bank, SIM card, and practical errands
- hobbies and weekend plans
- asking for directions
- family and introductions

Start beginner-friendly and mostly in present tense. If the user makes few or no mistakes, slowly make the dialogue more advanced while keeping it accessible.

The bot should act like a companion, not only a question generator. It may react, support, comment briefly, and then continue the conversation.

## Technical Stack

Use:

- Node.js
- TypeScript
- grammY for Telegram
- OpenAI API
- Structured LLM output
- PostgreSQL via Prisma from the beginning, so local and production use the same database model
- Docker Compose for local PostgreSQL
- Long polling for local development
- Webhook-ready structure for later deployment, but do not implement deployment now unless needed

Avoid overengineering. Build a clean MVP with boundaries that are easy to extend.

## Environment Variables

Create `.env.example` with:

```env
TELEGRAM_BOT_TOKEN=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o
DATABASE_URL=postgresql://sol:sol@localhost:5432/sol_de_manana
NODE_ENV=development
```

The OpenAI model must be configurable at runtime through `OPENAI_MODEL`.

## Suggested Repo Structure

Use this structure unless there is a strong reason to adjust:

```text
.
├── src
│   ├── bot
│   │   ├── commands.ts
│   │   └── handlers.ts
│   ├── config
│   │   └── env.ts
│   ├── db
│   │   ├── prisma.ts
│   │   └── chatHistory.ts
│   ├── llm
│   │   ├── openaiClient.ts
│   │   ├── schemas.ts
│   │   └── solService.ts
│   ├── prompts
│   │   └── solSystemPrompt.ts
│   ├── conversation
│   │   ├── themes.ts
│   │   └── context.ts
│   ├── testing
│   │   └── fixtures.ts
│   └── index.ts
├── prisma
│   └── schema.prisma
├── tests
│   ├── language-behavior.test.ts
│   ├── formatting.test.ts
│   ├── prompt-assembly.test.ts
│   ├── nonsense.test.ts
│   └── bot-handlers.test.ts
├── docker-compose.yml
├── Dockerfile
├── README.md
├── TESTING.md
├── .env.example
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

## Data Model

Store history per Telegram chat.

Use PostgreSQL with Prisma.

Suggested tables:

```text
Chat
- id
- telegramChatId
- currentTheme
- themeReplyCount
- createdAt
- updatedAt

Message
- id
- chatId
- role: user | assistant
- text
- llmJson optional
- createdAt
```

Keep only the last 10-15 messages in the LLM context for token saving and performance. Storing more in the database is acceptable, but the prompt context must be limited.

Store `currentTheme` and `themeReplyCount` in the database. This is better for token usage and predictable behavior than asking the LLM to infer everything from history.

## OpenAI Integration

Use the current OpenAI SDK for Node.js.

Prefer a structured response schema. The internal response should include fields similar to:

```ts
type SolResponse = {
  inputLanguage: "spanish" | "russian" | "mixed" | "unsupported" | "nonsense";
  isTooShort: boolean;
  correctionOrTranslation: string | null;
  reminder: string | null;
  continuation: string;
  nextQuestion: string | null;
  theme: string;
  shouldChangeTheme: boolean;
};
```

The final Telegram message must be assembled by code from this structured output to preserve stable formatting.

If the LLM returns invalid structured output:

1. Retry once with a compact repair instruction.
2. If it fails again, send a short Spanish/Russian fallback asking the user to try again.
3. Log the failure without exposing technical details to the user.

## Telegram Bot Behavior

Implement only `/start` for now.

`/start` should:

1. Create or reset chat state if needed.
2. Select a random initial theme.
3. Send a welcoming message.
4. Immediately start the first dialogue prompt.

No `/help`, `/level`, `/topic`, `/reset`, or stats commands in the MVP.

## Implementation Milestones

Work step by step. Keep each milestone small and commit after each feature, refactor, or fix.

### Milestone 1: Project Scaffold

- Initialize TypeScript Node.js project.
- Add grammY, OpenAI SDK, Prisma, testing dependencies, lint/format tooling as needed.
- Add `.env.example`.
- Add Docker Compose for PostgreSQL.
- Add basic folder structure.
- Commit with a conventional message, for example:
  `feat: scaffold sol de manana bot`

### Milestone 2: Configuration and Database

- Implement typed env loading.
- Define Prisma schema.
- Implement database client.
- Implement chat state and message history helpers.
- Add tests for history/context trimming.
- Commit.

### Milestone 3: Conversation Prompt and Structured Output

- Implement themes.
- Implement system prompt.
- Implement structured OpenAI response schema.
- Implement LLM service.
- Add mocked tests for prompt assembly and response parsing.
- Commit.

### Milestone 4: Telegram Bot

- Implement grammY bot setup.
- Implement `/start`.
- Implement text message handling.
- Save user and assistant messages.
- Assemble final Telegram messages in the required order.
- Commit.

### Milestone 5: Behavior Tests

- Add tests for:
  - Spanish correction behavior
  - Russian translation behavior
  - mixed Spanish-Russian behavior
  - English rejection
  - nonsense rejection
  - too-short answer reminder
  - theme continuation for 4-8 replies
  - final message ordering
- Mock OpenAI responses. Do not call real APIs in tests.
- Commit.

### Milestone 6: Docs

- Add README with local setup.
- Add TESTING.md with testing strategy and commands.
- Add notes for local polling and future deployment readiness.
- Commit.

## Testing Responsibilities

Treat testing as a first-class responsibility.

The test suite must cover:

- language detection behavior via mocked LLM outputs
- message formatting
- prompt and answer assembly
- nonsense determination
- short-answer behavior
- theme count and theme switching
- Telegram handlers with mocked dependencies
- database helpers

Do not rely on live OpenAI calls in automated tests.

If a testing engineer agent is available, use it to review edge cases and missing test coverage after implementation.

## Code Quality Rules

- Keep the MVP small.
- Do not add dependencies just because they might be useful later.
- Use TypeScript types strictly.
- Keep prompt text centralized.
- Keep Telegram formatting assembly in code, not hidden inside model prose.
- Log technical errors, but keep user-facing errors warm and short.
- Avoid broad abstractions before they are needed.
- Run tests and type checks before finalizing changes when possible.

## Git Rules

- Commit after every feature, refactor, or fix.
- Use conventional commits, for example:
  - `feat: add telegram start command`
  - `feat: add structured openai response`
  - `test: cover short answer behavior`
  - `fix: handle invalid llm output`
  - `docs: add local setup instructions`

Do not create large mixed commits.

## Collaboration Rules

- Before making any change, briefly explain what you are going to do and how. Wait for the user to confirm before proceeding.
- After every fix or addition, create a git commit with a conventional commit message.

## MVP Definition of Done

The MVP is done when:

- The bot starts locally with grammY long polling.
- `/start` sends a welcome message and first conversation prompt.
- User messages are processed through OpenAI structured output.
- Spanish, Russian, mixed input, English rejection, nonsense, and short answers follow the product rules.
- Chat history and theme state persist in PostgreSQL.
- Only the last 10-15 messages are used as LLM context.
- Tests cover core behavior without live OpenAI calls.
- README and TESTING.md explain local setup and verification.
