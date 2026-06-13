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
  summary: z.string()
    .describe("2-4 sentences in Russian summarising everything discussed in the conversation. Cover all topics equally — do not pick one as the main topic."),
  mistakes: z.array(z.string())
    .describe("Corrections from the conversation, each formatted as 'написал X → правильно Y'. Extract ONLY from explicit 'Corrección:' lines in the assistant messages. Do NOT invent mistakes. Do NOT treat 'En español:' translation lines as mistakes. Empty array [] if no Corrección lines exist."),
  usefulPhrases: z.array(z.string())
    .describe("3-5 useful Spanish phrases related to the topics discussed. Fill ONLY if mistakes is empty. If mistakes has any items, use []."),
  whatWentWell: z.string()
    .describe("What the user did well — 1 sentence in Russian"),
  focusArea: z.string()
    .describe("The single most important area to improve — 1 sentence in Russian"),
  encouragement: z.string()
    .describe("Short encouraging message in Russian, 1 sentence"),
});

export type DailyPracticeHighlights = z.infer<typeof DailyPracticeHighlightsSchema>;
