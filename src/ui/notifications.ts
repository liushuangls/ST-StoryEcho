interface ToastrLike {
  success(message: string, title?: string): void;
  error(message: string, title?: string): void;
  info(message: string, title?: string): void;
}

function toastr(): ToastrLike | undefined {
  return (globalThis as typeof globalThis & { toastr?: ToastrLike }).toastr;
}

export const notify = {
  success(message: string): void {
    toastr()?.success(message, 'StoryEcho');
  },
  error(message: string): void {
    const service = toastr();
    if (service) {
      service.error(message, 'StoryEcho');
    } else {
      console.error('[StoryEcho]', message);
    }
  },
  info(message: string): void {
    toastr()?.info(message, 'StoryEcho');
  },
};
