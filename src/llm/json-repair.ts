function stripJsonFence(raw: string): string {
  return raw
    .replace(/^\uFEFF/u, '')
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
}

interface JsonScanResult {
  balanced: string | null;
  closers: string[];
  endedInsideString: boolean;
}

function scanJsonValue(value: string): JsonScanResult {
  const objectStart = value.indexOf('{');
  const arrayStart = value.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  if (start < 0) {
    return { balanced: null, closers: [], endedInsideString: false };
  }

  const stack: string[] = [];
  let insideString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (insideString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }
    if (character === '"') {
      insideString = true;
      continue;
    }
    if (character === '{') {
      stack.push('}');
      continue;
    }
    if (character === '[') {
      stack.push(']');
      continue;
    }
    if (character !== '}' && character !== ']') {
      continue;
    }
    if (stack.at(-1) !== character) {
      return { balanced: null, closers: [], endedInsideString: false };
    }
    stack.pop();
    if (stack.length === 0) {
      return {
        balanced: value.slice(start, index + 1),
        closers: [],
        endedInsideString: false,
      };
    }
  }

  return {
    balanced: value.slice(start),
    closers: [...stack].reverse(),
    endedInsideString: insideString,
  };
}

function normalizeJsonSyntax(value: string): string {
  let result = '';
  let insideString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (insideString) {
      if (escaped) {
        result += character;
        escaped = false;
      } else if (character === '\\') {
        result += character;
        escaped = true;
      } else if (character === '"') {
        result += character;
        insideString = false;
      } else if (character === '\n') {
        result += '\\n';
      } else if (character === '\r') {
        result += '\\r';
      } else if (character === '\t') {
        result += '\\t';
      } else {
        result += character;
      }
      continue;
    }
    if (character === '"') {
      result += character;
      insideString = true;
      continue;
    }
    if (character === ',') {
      let next = index + 1;
      while (next < value.length && /\s/u.test(value[next]!)) {
        next += 1;
      }
      if (value[next] === '}' || value[next] === ']') {
        continue;
      }
    }
    result += character;
  }
  return result;
}

function candidateJsonTexts(raw: string): string[] {
  const stripped = stripJsonFence(raw);
  const scanned = scanJsonValue(stripped);
  const candidates = [stripped];
  if (scanned.balanced) {
    candidates.push(scanned.balanced);
    if (!scanned.endedInsideString && scanned.closers.length > 0) {
      candidates.push(`${scanned.balanced}${scanned.closers.join('')}`);
    }
  }
  return [...new Set(candidates.flatMap((candidate) => [
    candidate,
    normalizeJsonSyntax(candidate),
  ]).filter(Boolean))];
}

/**
 * Parse common provider formatting defects without another paid LLM call.
 * Repairs are deliberately syntax-only: fences/commentary, trailing commas,
 * literal controls inside strings and missing final structural delimiters.
 */
export function parseJsonWithLocalRepair(raw: string): unknown {
  let lastError: unknown;
  for (const candidate of candidateJsonTexts(raw)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('JSON无法通过本地语法修复解析。', { cause: lastError });
}

/** Return a canonical parseable JSON string for an existing typed parser. */
export function repairedJsonText(raw: string): string {
  return JSON.stringify(parseJsonWithLocalRepair(raw));
}
