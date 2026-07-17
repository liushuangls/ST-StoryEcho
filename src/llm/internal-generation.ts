let internalGenerationDepth = 0;

export function isInternalGeneration(): boolean {
  return internalGenerationDepth > 0;
}

export async function withInternalGeneration<T>(operation: () => Promise<T>): Promise<T> {
  internalGenerationDepth += 1;
  try {
    return await operation();
  } finally {
    internalGenerationDepth -= 1;
  }
}
