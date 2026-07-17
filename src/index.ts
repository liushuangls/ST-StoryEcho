import { logger } from './core/logger';
import type { TavernChatMessage } from './core/types';
import { storyEchoGenerateInterceptor as intercept } from './prompt/interceptor';
import { registerSettingsPanel } from './ui/settings-panel';

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

globalThis.storyEchoGenerateInterceptor = intercept;

let activationPromise: Promise<void> | undefined;

export function onActivate(): Promise<void> {
  if (activationPromise) {
    return activationPromise;
  }
  logger.info('扩展已加载。');
  activationPromise = registerSettingsPanel().catch((error) => {
    logger.error('初始化设置面板失败。', error);
  });
  return activationPromise;
}

void onActivate();
