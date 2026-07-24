import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  registerScheduler: vi.fn<(options?: { silent?: boolean }) => boolean>(),
  unregisterScheduler: vi.fn(),
  registerSettingsPanel: vi.fn<() => Promise<void>>(),
  unregisterSettingsPanel: vi.fn(),
}));

vi.mock('../src/background/scheduler', () => ({
  backgroundProcessingScheduler: {
    register: mocks.registerScheduler,
    unregister: mocks.unregisterScheduler,
  },
}));

vi.mock('../src/core/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock('../src/prompt/interceptor', () => ({
  storyEchoGenerateInterceptor: vi.fn(),
}));

vi.mock('../src/ui/settings-panel', () => ({
  registerSettingsPanel: mocks.registerSettingsPanel,
  unregisterSettingsPanel: mocks.unregisterSettingsPanel,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  mocks.loggerInfo.mockReset();
  mocks.loggerWarn.mockReset();
  mocks.loggerError.mockReset();
  mocks.registerScheduler.mockReset();
  mocks.unregisterScheduler.mockReset();
  mocks.registerSettingsPanel.mockReset();
  mocks.unregisterSettingsPanel.mockReset();
  mocks.registerSettingsPanel.mockResolvedValue();
});

afterEach(() => {
  globalThis.storyEchoGenerateInterceptor = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('extension activation', () => {
  it('retries scheduler registration when SillyTavern is not ready on first activation', async () => {
    mocks.registerScheduler
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    await import('../src/index');

    expect(mocks.registerScheduler).toHaveBeenCalledOnce();
    expect(mocks.registerScheduler).toHaveBeenNthCalledWith(1);

    await vi.advanceTimersByTimeAsync(250);

    expect(mocks.registerScheduler).toHaveBeenCalledTimes(2);
    expect(mocks.registerScheduler).toHaveBeenNthCalledWith(2, { silent: true });
    expect(mocks.registerSettingsPanel).toHaveBeenCalledOnce();
  });

  it('removes partially registered listeners before retrying a registration exception', async () => {
    const registrationError = new Error('event source rejected listener');
    mocks.registerScheduler
      .mockImplementationOnce(() => {
        throw registrationError;
      })
      .mockReturnValue(true);

    await import('../src/index');

    expect(mocks.unregisterScheduler).toHaveBeenCalledOnce();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      '注册后台剧情整理事件失败，将自动重试。',
      registrationError,
    );

    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.registerScheduler).toHaveBeenCalledTimes(2);
  });

  it('allows a later activation to retry after the bounded startup window expires', async () => {
    mocks.registerScheduler.mockReturnValue(false);
    const extension = await import('../src/index');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.registerScheduler).toHaveBeenCalledTimes(41);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'SillyTavern上下文长时间未就绪；后台剧情整理将在扩展下次激活时重新注册。',
    );

    mocks.registerScheduler.mockReturnValue(true);
    await extension.onActivate();

    expect(mocks.registerScheduler).toHaveBeenCalledTimes(42);
    expect(mocks.registerSettingsPanel).toHaveBeenCalledTimes(2);
  });

  it('tears down listeners and cancels pending startup retries when disabled', async () => {
    mocks.registerScheduler.mockReturnValue(false);
    const extension = await import('../src/index');
    expect(globalThis.storyEchoGenerateInterceptor).toBeTypeOf('function');

    extension.onDisable();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.registerScheduler).toHaveBeenCalledOnce();
    expect(mocks.unregisterScheduler).toHaveBeenCalledOnce();
    expect(mocks.unregisterSettingsPanel).toHaveBeenCalledOnce();
    expect(globalThis.storyEchoGenerateInterceptor).toBeUndefined();

    mocks.registerScheduler.mockReturnValue(true);
    await extension.onEnable();

    expect(mocks.registerScheduler).toHaveBeenCalledTimes(2);
    expect(mocks.registerSettingsPanel).toHaveBeenCalledTimes(2);
    expect(globalThis.storyEchoGenerateInterceptor).toBeTypeOf('function');
  });
});
