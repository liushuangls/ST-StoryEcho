import { backgroundProcessingScheduler } from './background/scheduler';
import { logger } from './core/logger';
import type { TavernChatMessage } from './core/types';
import { storyEchoGenerateInterceptor as intercept } from './prompt/interceptor';
import { registerSettingsPanel, unregisterSettingsPanel } from './ui/settings-panel';

declare global {
  var storyEchoGenerateInterceptor:
    | ((
        chat: TavernChatMessage[],
        contextSize: number,
        abort: () => void,
        type?: string,
      ) => Promise<void>)
    | undefined;
}

const SCHEDULER_REGISTRATION_RETRY_DELAY_MS = 250;
const SCHEDULER_REGISTRATION_MAX_ATTEMPTS = 40;

let activationLogged = false;
let active = false;
let activationGeneration = 0;
let schedulerRegistrationPromise: Promise<void> | undefined;

function waitForSchedulerRetry(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, SCHEDULER_REGISTRATION_RETRY_DELAY_MS);
  });
}

function attemptSchedulerRegistration(silent = false): boolean {
  try {
    return silent
      ? backgroundProcessingScheduler.register({ silent: true })
      : backgroundProcessingScheduler.register();
  } catch (error) {
    backgroundProcessingScheduler.unregister();
    if (!silent) {
      logger.warn('注册后台剧情整理事件失败，将自动重试。', error);
    }
    return false;
  }
}

async function retrySchedulerRegistration(generation: number): Promise<void> {
  for (let attempt = 0; attempt < SCHEDULER_REGISTRATION_MAX_ATTEMPTS; attempt += 1) {
    await waitForSchedulerRetry();
    if (!active || generation !== activationGeneration) {
      return;
    }
    if (attemptSchedulerRegistration(true)) {
      return;
    }
  }
  if (active && generation === activationGeneration) {
    logger.warn('SillyTavern上下文长时间未就绪；后台剧情整理将在扩展下次激活时重新注册。');
  }
}

function ensureSchedulerRegistered(): Promise<void> {
  if (!active) {
    return Promise.resolve();
  }
  if (attemptSchedulerRegistration()) {
    return Promise.resolve();
  }
  if (!schedulerRegistrationPromise) {
    let trackedOperation: Promise<void>;
    trackedOperation = retrySchedulerRegistration(activationGeneration).finally(() => {
      if (schedulerRegistrationPromise === trackedOperation) {
        schedulerRegistrationPromise = undefined;
      }
    });
    schedulerRegistrationPromise = trackedOperation;
  }
  return schedulerRegistrationPromise;
}

export function onActivate(): Promise<void> {
  if (!active) {
    active = true;
    activationGeneration += 1;
  }
  globalThis.storyEchoGenerateInterceptor = intercept;
  if (!activationLogged) {
    activationLogged = true;
    logger.info('扩展已加载。');
  }
  // Scheduler registration retries in the background. SillyTavern lifecycle
  // hooks have a five-second budget, so a temporarily missing context must not
  // make activation itself time out.
  void ensureSchedulerRegistered();
  return registerSettingsPanel().catch((error) => {
    logger.error('初始化设置面板失败。', error);
  });
}

export function onDisable(): void {
  active = false;
  activationGeneration += 1;
  schedulerRegistrationPromise = undefined;
  backgroundProcessingScheduler.unregister();
  unregisterSettingsPanel();
  if (globalThis.storyEchoGenerateInterceptor === intercept) {
    globalThis.storyEchoGenerateInterceptor = undefined;
  }
}

export function onEnable(): Promise<void> {
  return onActivate();
}

void onActivate();
