# Sol de Mañana

A Telegram bot for conversational Spanish practice. A warm companion for beginner learners who are moving to Spain. It detects your language, corrects mistakes, translates Russian to Spanish, and keeps a natural conversation going across rotating topics.

## Prerequisites

- Node.js 20+
- Docker and Docker Compose
- A Telegram bot token (create one with [@BotFather](https://t.me/BotFather))
- An OpenAI API key

## Local Setup

**1. Install dependencies**

```sh
npm install
npx prisma generate
```

**2. Configure environment**

```sh
cp .env.example .env
```

Open `.env` and fill in:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
OPENAI_API_KEY=your_openai_api_key
```

The other values work as-is for local development.

**3. Start the database**

```sh
docker compose up -d
```

**4. Apply the migrations**

```sh
npx prisma migrate dev
```

This applies the versioned migrations from `prisma/migrations` to the local
database. In deployment the container runs `npx prisma migrate deploy` on
start instead, which applies pending migrations without generating new ones.

**5. Start the bot**

```sh
npm run dev
```

The bot starts with long polling. Open Telegram, find your bot, and send `/start`.

## Usage

- `/start` — resets the conversation and starts a new dialogue on a random topic
- Write in Spanish to get corrections with bolded fixes
- Write in Russian to get a Spanish translation and continuation
- Short answers ("sí", "да") trigger a full-sentence example prompt
- English or other languages get a brief warning

## Repo Structure

```
src/
  bot/          # Telegram handlers (handleStart, handleMessage) and commands
  config/       # Environment variable loading
  conversation/ # Theme list, theme switching logic, LLM context builder
  db/           # Prisma client singleton and chat/message helpers
  llm/          # OpenAI client, Zod schema for structured output, LLM service
  prompts/      # System prompt builder
  testing/      # Shared test fixtures
prisma/         # Database schema
tests/          # Test suite (all tests mock OpenAI — no live API calls)
```

## Type Checking

```sh
npm run build
```

This runs `tsc --noEmit` and reports any type errors without emitting files.
