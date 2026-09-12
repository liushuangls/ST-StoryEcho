import type { StoryEchoSettings } from '../core/types';
import { getConnectionProfiles, type ConnectionProfileInfo } from '../platform/connection-profiles';

const PROFILE_PREFIX = 'profile:';

export interface ConnectionSelectOption {
  value: string;
  label: string;
  disabled: boolean;
}

export function connectionSelectValue(settings: StoryEchoSettings): string {
  return settings.llm.provider === 'connection-profile'
    ? `${PROFILE_PREFIX}${settings.llm.connectionProfileId}`
    : settings.llm.provider;
}

export function applyConnectionSelectValue(settings: StoryEchoSettings, value: string): void {
  if (value.startsWith(PROFILE_PREFIX)) {
    settings.llm.provider = 'connection-profile';
    settings.llm.connectionProfileId = value.slice(PROFILE_PREFIX.length);
  } else if (value === 'main' || value === 'openai-compatible') {
    settings.llm.provider = value;
  }
}

export function connectionSelectOptions(
  settings: StoryEchoSettings,
  profiles: ConnectionProfileInfo[],
): ConnectionSelectOption[] {
  const options: ConnectionSelectOption[] = [
    { value: 'main', label: 'SillyTavern / Luker 主连接', disabled: false },
    ...profiles.map((profile) => ({
      value: `${PROFILE_PREFIX}${profile.id}`,
      label: `插头：${profile.name}${profile.model ? ` · ${profile.model}` : ''}${
        profile.unavailableReason ? `（${profile.unavailableReason}）` : ''}`,
      disabled: Boolean(profile.unavailableReason),
    })),
    { value: 'openai-compatible', label: '自定义 OpenAI 兼容接口', disabled: false },
  ];
  const selected = connectionSelectValue(settings);
  if (!options.some((option) => option.value === selected)) {
    options.push({ value: selected, label: '原选插头已删除／不可用，请重新选择', disabled: true });
  }
  return options;
}

export function syncConnectionSelect(select: HTMLSelectElement, settings: StoryEchoSettings): void {
  let profiles: ConnectionProfileInfo[] = [];
  try {
    profiles = getConnectionProfiles();
  } catch {
    // Mounting before the host context is ready must keep the saved selection.
  }
  const options = connectionSelectOptions(settings, profiles);
  const signature = JSON.stringify(options);
  if (select.dataset['connectionOptions'] !== signature) {
    select.replaceChildren(...options.map((item) => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      option.disabled = item.disabled;
      return option;
    }));
    select.dataset['connectionOptions'] = signature;
  }
  select.value = connectionSelectValue(settings);
}
