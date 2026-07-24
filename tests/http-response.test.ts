import { describe, expect, it, vi } from 'vitest';
import { readResponseTextWithLimit } from '../src/http/response';

describe('readResponseTextWithLimit', () => {
  it('decodes multibyte text split across response chunks', async () => {
    const bytes = new TextEncoder().encode('剧情正常');
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    }));

    await expect(readResponseTextWithLimit(response, bytes.byteLength, '响应过大。'))
      .resolves.toBe('剧情正常');
  });

  it('cancels a chunked response as soon as its accumulated bytes exceed the cap', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.enqueue(new Uint8Array([7, 8, 9]));
      },
      cancel,
    }));

    await expect(readResponseTextWithLimit(response, 5, '响应过大。'))
      .rejects.toThrow('响应过大。');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects and cancels a declared oversized response before reading its body', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull,
      cancel,
    }), {
      headers: { 'content-length': '2048' },
    });

    await expect(readResponseTextWithLimit(response, 1024, '响应过大。'))
      .rejects.toThrow('响应过大。');
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
  });
});
