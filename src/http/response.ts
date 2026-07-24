export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<string> {
  const declaredLengthHeader = response.headers.get('content-length');
  const declaredLength = declaredLengthHeader === null
    ? Number.NaN
    : Number(declaredLengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // The declared response size is already sufficient to reject it.
    }
    throw new Error(tooLargeMessage);
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(tooLargeMessage);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size error below is authoritative even if cancellation races
          // with an already-closed or failed response stream.
        }
        throw new Error(tooLargeMessage);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    reader.releaseLock();
  }
}
