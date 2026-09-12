/** Recognize direct model IDs and common provider/model prefixes. */
export function isGeminiModel(model: string): boolean {
  return /(?:^|[/:])gemini(?:[-_.]|$)/iu.test(model.trim());
}

export function isGemini3Model(model: string): boolean {
  return /(?:^|[/:])gemini-3(?:[.-]|$)/iu.test(model.trim());
}
