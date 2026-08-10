/** Each Level 1 or higher-level summary LLM attempt may run for up to five minutes. */
export const SUMMARY_LLM_TIMEOUT_MS = 300_000;

/** Blue- and green-light world-book references share this formatted character budget. */
export const SUMMARY_WORLD_INFO_CHARACTER_BUDGET = 50_000;

/** The UI may raise the green-light match count while the shared character budget stays bounded. */
export const MAX_SUMMARY_MATCHED_WORLD_INFO_ENTRIES = 100;
