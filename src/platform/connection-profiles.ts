import { getContext, type SillyTavernContext } from './sillytavern';

/** Safe display/request identity; never copies keys, URLs or proxy passwords. */
export interface ConnectionProfileInfo {
  id: string;
  name: string;
  api: string;
  model: string;
  mainApi: string;
  source: string;
  unavailableReason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getConnectionProfiles(context = getContext()): ConnectionProfileInfo[] {
  const manager = context.extensionSettings['connectionManager'];
  if (!isRecord(manager) || !Array.isArray(manager['profiles'])) {
    return [];
  }
  const disabled = context.extensionSettings['disabledExtensions'];
  const managerDisabled = Array.isArray(disabled) && disabled.includes('connection-manager');
  const seen = new Set<string>();
  return manager['profiles'].flatMap((profile: unknown): ConnectionProfileInfo[] => {
    if (!isRecord(profile)) return [];
    const id = stringValue(profile['id']);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const api = stringValue(profile['api']);
    const mode = stringValue(profile['mode']);
    const mapping = context.CONNECT_API_MAP?.[api];
    const mainApi = mapping?.selected ?? '';
    const source = mapping?.source || mapping?.type || '';
    const generative = (!mode || mode === 'cc' || mode === 'tc')
      && (mainApi === 'openai' || mainApi === 'textgenerationwebui') && Boolean(source);
    const unavailableReason = !generative
      ? '不支持文本生成'
      : managerDisabled
        ? '连接管理器已禁用'
        : !context.ConnectionManagerRequestService?.sendRequest || !context.extractMessageFromData
          ? '当前宿主不支持独立插头请求'
          : '';
    return [{
      id,
      name: stringValue(profile['name']) || id,
      api,
      model: stringValue(profile['model']),
      mainApi,
      source,
      unavailableReason,
    }];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function getConnectionProfile(
  id: string,
  context: SillyTavernContext = getContext(),
): ConnectionProfileInfo | undefined {
  return getConnectionProfiles(context).find((profile) => profile.id === id);
}
