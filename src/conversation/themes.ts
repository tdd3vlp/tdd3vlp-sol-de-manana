export const THEMES = [
  "moving to Spain",
  "apartment search",
  "supermarket",
  "cafe or restaurant",
  "public transport",
  "doctor and pharmacy",
  "documents and bureaucracy",
  "meeting neighbors",
  "work or study",
  "Spanish culture",
  "Spanish history",
  "city life in Spain",
  "weather and daily routine",
  "shopping and clothes",
  "bank, SIM card, and practical errands",
  "hobbies and weekend plans",
  "asking for directions",
  "family and introductions",
] as const;

export type Theme = (typeof THEMES)[number];

export function pickRandomTheme(): string {
  return THEMES[Math.floor(Math.random() * THEMES.length)];
}

export function shouldChangeTheme(count: number): boolean {
  if (count < 4) return false;
  if (count >= 8) return true;
  // Randomly decide between count 4–7 with increasing probability
  const threshold = Math.floor(Math.random() * 5) + 4; // 4, 5, 6, 7, or 8
  return count >= threshold;
}
