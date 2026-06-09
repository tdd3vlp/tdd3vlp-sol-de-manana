import { z } from "zod";

export const SolResponseSchema = z.object({
  inputLanguage: z.enum(["spanish", "russian", "mixed", "unsupported", "nonsense"]),
  correctionOrTranslation: z.string().nullable(),
  continuation: z.string(),
  theme: z.string(),
});

export type SolResponse = z.infer<typeof SolResponseSchema>;
