/** "ETERNAL LIMITED" → "Eternal"; "Larsen & Toubro Limited" → "Larsen & Toubro". */
export function displayName(official: string): string {
  let name = official.replace(/\s+(limited|ltd\.?)$/i, "").trim();
  if (name === name.toUpperCase() && /[A-Z]{4,}/.test(name)) {
    name = name
      .toLowerCase()
      .replace(/\b([a-z])/g, (c) => c.toUpperCase())
      .replace(/\b(And|Of|The|For)\b/g, (w) => w.toLowerCase());
  }
  return name;
}
