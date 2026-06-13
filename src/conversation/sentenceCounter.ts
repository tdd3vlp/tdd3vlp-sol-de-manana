const SENTENCE_TERMINATORS = /[.!?…\n¿¡]/;

const SHORT_VALID_RESPONSES = new Set([
  "sí", "si", "no", "vale", "okay", "ok", "claro", "gracias", "de nada",
  "no sé", "no se", "buenas", "hola", "adiós", "hasta luego",
  "да", "нет", "хорошо", "спасибо", "конечно", "понятно", "не знаю",
]);

export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  if (SHORT_VALID_RESPONSES.has(trimmed.toLowerCase())) return 1;

  const fragments = trimmed.split(SENTENCE_TERMINATORS).filter((f) => f.trim().length > 0);
  return Math.max(1, fragments.length);
}
