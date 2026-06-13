import { z } from "zod";

export const DailyPracticeResponseSchema = z.object({
  inputLanguage: z.enum(["spanish", "russian", "mixed", "unsupported", "nonsense"]),
  correctionOrTranslation: z.string().nullable()
    .describe("The corrected Spanish sentence or Russian-to-Spanish translation only. One sentence, plain text. Null if no correction needed."),
  continuation: z.string()
    .describe("Dialogue continuation and next question. Always ends with exactly one open-ended question."),
});

export type DailyPracticeResponse = z.infer<typeof DailyPracticeResponseSchema>;

export const DailyPracticeHighlightsSchema = z.object({
  topic: z.string()
    .describe("The main topic practiced today in Russian, e.g. 'Кафе и рестораны'"),
  subtopics: z.array(z.string()).min(1).max(4)
    .describe("2-4 high-level topic areas covered in the conversation, in Russian. Each item is a short topic phrase (e.g. 'Описание квартиры', 'Общение с арендодателем') — not a literal phrase from the dialogue."),
  whatWentWell: z.string()
    .describe("What the user did well — 1 sentence in Russian"),
  focusArea: z.string()
    .describe("The single most important area to improve — 1 sentence in Russian"),
  encouragement: z.string()
    .describe("Short encouraging message in Russian, 1 sentence"),
});

export type DailyPracticeHighlights = z.infer<typeof DailyPracticeHighlightsSchema>;
