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
