import { z } from "zod";

export const DailyPracticeResponseSchema = z.object({
  inputLanguage: z.enum(["spanish", "russian", "mixed", "unsupported", "nonsense"]),
  correctionOrTranslation: z.string().nullable()
    .describe("The corrected Spanish sentence or Russian-to-Spanish translation only. One sentence, plain text. Null if no correction needed."),
  continuation: z.string()
    .describe("Dialogue continuation and next question. Always ends with exactly one question."),
});

export type DailyPracticeResponse = z.infer<typeof DailyPracticeResponseSchema>;

export const DailyPracticeHighlightsSchema = z.object({
  phrases: z.array(z.string()).min(1).max(4)
    .describe("2-4 useful Spanish phrases or expressions the user practiced today"),
  corrections: z.array(z.string()).max(3)
    .describe("1-2 corrections made during the session, or empty array if no errors"),
  encouragement: z.string()
    .describe("Short encouraging message in Russian, 1 sentence"),
});

export type DailyPracticeHighlights = z.infer<typeof DailyPracticeHighlightsSchema>;
