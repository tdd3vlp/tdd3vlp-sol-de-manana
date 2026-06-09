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

export const THEME_LABELS: Record<string, string> = {
  "moving to Spain": "Переезд в Испанию",
  "apartment search": "Поиск квартиры",
  "supermarket": "Супермаркет",
  "cafe or restaurant": "Кафе или ресторан",
  "public transport": "Транспорт",
  "doctor and pharmacy": "Врач и аптека",
  "documents and bureaucracy": "Документы",
  "meeting neighbors": "Знакомство с соседями",
  "work or study": "Работа или учёба",
  "Spanish culture": "Культура Испании",
  "Spanish history": "История Испании",
  "city life in Spain": "Жизнь в городе",
  "weather and daily routine": "Погода и быт",
  "shopping and clothes": "Шопинг",
  "bank, SIM card, and practical errands": "Банк и SIM",
  "hobbies and weekend plans": "Хобби и выходные",
  "asking for directions": "Как спросить дорогу",
  "family and introductions": "Семья и знакомства",
};

export function pickRandomTheme(): string {
  return THEMES[Math.floor(Math.random() * THEMES.length)];
}

export function pickRandomThemes(n: number): string[] {
  return [...THEMES].sort(() => Math.random() - 0.5).slice(0, n);
}

export function shouldChangeTheme(count: number): boolean {
  if (count < 4) return false;
  if (count >= 8) return true;
  // Randomly decide between count 4–7 with increasing probability
  const threshold = Math.floor(Math.random() * 5) + 4; // 4, 5, 6, 7, or 8
  return count >= threshold;
}
