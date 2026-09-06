/** Stable excerpts from the candidate only. IDs avoid asking the Judge to retype
 * long quotes (and accidentally rearrange them); labels remain local to a run. */
export function candidateEvidenceSegments(text: string): { id: number; text: string }[] {
  const segments: string[] = [];
  for (const sentence of text.match(/[^。！？\n]+[。！？]?/gu) ?? []) {
    const characters = Array.from(sentence.trim());
    for (let start = 0; start < characters.length; start += 240) {
      const segment = characters.slice(start, start + 240).join('').trim();
      if (segment) segments.push(segment);
    }
  }
  return segments.map((text, index) => ({ id: index + 1, text }));
}

export function resolveEvidenceIds(value: unknown, candidate: string): string {
  const segments = candidateEvidenceSegments(candidate);
  if (!Array.isArray(value) || value.length > 24 || new Set(value).size !== value.length
    || value.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > segments.length)) {
    throw new Error('Judge evidenceIds 必须是候选片段中有效、不重复的编号（最多 24 个）。');
  }
  return [...value as number[]].sort((a, b) => a - b).map((id) => segments[id - 1]!.text).join('……');
}
