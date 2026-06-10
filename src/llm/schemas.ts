import { z } from "zod";

export const SolResponseSchema = z.object({
  inputLanguage: z.enum(["spanish", "russian", "mixed", "unsupported", "nonsense"]),
  correctionOrTranslation: z.string().nullable()
    .describe("The corrected Spanish sentence or Russian-to-Spanish translation only. One sentence, plain text. Null if no correction needed. Never put dialogue or continuation here."),
  continuation: z.string()
    .describe("Dialogue continuation and next question. Never put corrections or translations here."),
  theme: z.string(),
});

export type SolResponse = z.infer<typeof SolResponseSchema>;
