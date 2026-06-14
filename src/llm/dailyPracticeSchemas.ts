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
  usefulPhrases: z.array(z.string()).min(4).max(7)
    .describe("4-7 useful Spanish phrases related to the topics discussed. Each on one line with brief Russian gloss: 'ir al mercado — сходить на рынок'. ALWAYS fill this, even if mistakes is non-empty."),
  whatWentWell: z.string()
    .describe("What the user did well — 1 sentence in Russian"),
  focusArea: z.string()
    .describe("The single most important area to improve — 1 sentence in Russian"),
  languageNote: z.string()
    .describe("Compact note in Russian: grammar rule, usage nuance, etymology, fixed expression, or distinction between similar words. Related to the conversation. 1-3 sentences, not a lecture."),
  cultureNote: z.string()
    .describe("Compact cultural note in Russian about the conversation topic. Give only widely-known, safe facts. If you lack factual confidence, provide mild everyday Spain context without specific dates or statistics. Do not invent facts."),
  nextPracticeHint: z.string()
    .describe("1-2 sentences in Russian: what to try or practice in the next conversation."),
  encouragement: z.string()
    .describe("Short encouraging message in Russian, 1 sentence"),
});

export type DailyPracticeHighlights = z.infer<typeof DailyPracticeHighlightsSchema>;
