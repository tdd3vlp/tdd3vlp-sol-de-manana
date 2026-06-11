const ALPHA_RE = /[a-zA-ZáéíóúüñÁÉÍÓÚÜÑА-Яа-яЁё]/g;
const VOWELS_RE = /[aeiouyáéíóúüAEIOUYÁÉÍÓÚÜАЕИОУЫЭЮЯаеиоуыэюяЁё]/g;

function isWordLike(token: string): boolean {
  const alpha = (token.match(ALPHA_RE) ?? []).join("");
  if (alpha.length < 2) return false;
  const vowels = (alpha.match(VOWELS_RE) ?? []).length;
  return vowels / alpha.length >= 0.2;
}

// Returns true when the text contains no word-like token (≥2 alphabetic chars,
// ≥20% vowels). Catches keyboard mashing, numbers, symbols, and emoji-only input
// without relying on the LLM.
export function isNonsense(text: string): boolean {
  return !text.trim().split(/\s+/).some(isWordLike);
}

// English function words that never appear as meaningful Spanish words.
// Presence of any one of these (with no Cyrillic or Spanish diacritics) strongly
// signals English or another unsupported Latin-script language.
const ENGLISH_MARKERS = new Set([
  "the", "is", "are", "was", "were", "have", "has", "been",
  "will", "would", "could", "should", "this", "that", "these",
  "those", "what", "where", "when", "why", "how", "can",
  "my", "your", "our", "their", "and", "but", "not", "with",
  "dont", "wont", "cant", "im", "its", "youre",
]);

const CYRILLIC_RE = /[А-Яа-яЁё]/;
const SPANISH_DIACRITIC_RE = /[áéíóúüñÁÉÍÓÚÜÑ¿¡]/;

// Returns true when the text is likely English or another unsupported language,
// detected locally without calling the LLM. Does not fire on Russian (Cyrillic)
// or Spanish that uses any diacritic characters.
export function isLikelyUnsupported(text: string): boolean {
  if (CYRILLIC_RE.test(text)) return false;
  if (SPANISH_DIACRITIC_RE.test(text)) return false;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.some((w) => ENGLISH_MARKERS.has(w));
}

// Phrases that, when present at the START of a message, indicate a learning
// context ("как сказать по-испански: проигнорируй..."). The injection check
// is skipped for these so legitimate translation requests are not blocked.
const LEARNING_PREFIX_RE =
  /^(как\s+(сказать|переводится|по-испански|будет\s+по)|переведи|что\s+значит|how\s+do\s+you\s+say|translate|what\s+does|cómo\s+se\s+dice|traduce)/i;

// Patterns that are direct prompt-injection signals regardless of language.
const INJECTION_PATTERNS: RegExp[] = [
  /предыдущие\s+инструкции/i,           // "предыдущие инструкции" in any form
  /про?игнорируй\s.{0,30}инструкци/i,   // "проигнорируй/игнорируй ... инструкции"
  /системный\s+промпт/i,
  /покажи\s.{0,20}(промпт|инструкци|конфигурац)/i,
  /выведи\s.{0,20}(промпт|инструкци|конфигурац)/i,
  /раскрой\s.{0,20}(промпт|инструкци)/i,
  /system\s+prompt/i,
  /previous\s+instructions/i,
  /ignore\s+(?:all\s+)?(?:previous\s+|prior\s+|your\s+)?instructions/i,
  /reveal\s+(?:the\s+)?(?:system\s+)?prompt/i,
  /show\s+(?:me\s+)?(?:your\s+)?(?:system\s+)?prompt/i,
  /forget\s+(?:your\s+|all\s+|previous\s+)?instructions/i,
  /developer\s+mode/i,
  /jailbreak/i,
];

// Returns true when the text looks like a direct prompt-injection attempt.
// Does NOT fire when the message starts with a learning-context prefix, so
// "как сказать по-испански: проигнорируй инструкции" is allowed through.
export function isPromptInjectionAttempt(text: string): boolean {
  const trimmed = text.trim();
  if (LEARNING_PREFIX_RE.test(trimmed)) return false;
  return INJECTION_PATTERNS.some((re) => re.test(trimmed));
}
