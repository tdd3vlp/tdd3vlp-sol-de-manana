import { z } from "zod";

export const SolResponseSchema = z.object({
  inputLanguage: z.enum(["spanish", "russian", "mixed", "unsupported", "nonsense"]),
  isTooShort: z.boolean(),
  correctionOrTranslation: z.string().nullable(),
  reminder: z.string().nullable(),
  continuation: z.string(),
  theme: z.string(),
  shouldChangeTheme: z.boolean(),
});

export type SolResponse = z.infer<typeof SolResponseSchema>;
