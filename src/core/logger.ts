const PREFIX = '[StoryEcho]';

export const logger = {
  debug(message: string, details?: unknown): void {
    if (details === undefined) {
      console.debug(PREFIX, message);
      return;
    }
    console.debug(PREFIX, message, details);
  },

  info(message: string, details?: unknown): void {
    if (details === undefined) {
      console.info(PREFIX, message);
      return;
    }
    console.info(PREFIX, message, details);
  },

  warn(message: string, details?: unknown): void {
    if (details === undefined) {
      console.warn(PREFIX, message);
      return;
    }
    console.warn(PREFIX, message, details);
  },

  error(message: string, error?: unknown): void {
    if (error === undefined) {
      console.error(PREFIX, message);
      return;
    }
    console.error(PREFIX, message, error);
  },
};
