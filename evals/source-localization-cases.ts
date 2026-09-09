import { buildPromptEvalCase } from './cases';
import { findSavedRunCase } from './case-catalog';
import { caseEvaluationHash, evalHash } from './protocol';
import type { LocalizationInput } from './source-localization';

export const LOCALIZATION_ARCHIVES = {
  'production-r1': '345c7f2dbbfaa6bba2298c10355ee46dbd0b7a2998ef5b98061093a424b92a85',
  'candidate-r2': 'af2549d34a0bcbb463e5c89a5a71e9b104ec1591eb5b4fb36ea4ab4f62e99b88',
  'production-r2': '20628a4f1c89718736673cbef3f81edad415a3e00a5d3d88d44d3588ed4ad261',
} as const;
export type LocalizationArchive = keyof typeof LOCALIZATION_ARCHIVES;

export const ATTRIBUTION_NEEDLE = '但指出私印不能证明';
export const CAMPUS_INSERTION_POINT = '悠请求千纱以后不要带恋爱对象回公寓，千纱答应保留私人空间，但再次说明自己仍可能谈恋爱。';
const TRUCE = 'validation-l2-city-state-truce', CAMPUS = 'l2-campus-ensemble-and-slow-burn', THEATRE = 'validation-l2-touring-theatre';

interface BaseDraft { draft: string; archiveHash: string }
export interface LocalizationBaseDrafts {
  truceCandidate: BaseDraft;
  truceProduction: BaseDraft;
  campus: BaseDraft;
  theatre: BaseDraft;
  truceUnchanged: BaseDraft;
}

function replaceOnce(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error('定位对照的最小修改锚点缺失或重复。');
  return text.replace(from, to);
}

export function assembleLocalizationCases(base: LocalizationBaseDrafts): LocalizationInput[] {
  function make(id: string, caseId: string, original: BaseDraft, mode: 'bad' | 'corrected' | 'unchanged'): LocalizationInput {
    const testCase = findSavedRunCase(caseId);
    if (!testCase || testCase.kind !== 'l2') throw new Error('定位夹具来源不存在。');
    let draft = original.draft;
    if (mode === 'corrected') draft = caseId === TRUCE
      ? replaceOnce(draft, ATTRIBUTION_NEEDLE, '但私印不能证明')
      : replaceOnce(draft, CAMPUS_INSERTION_POINT, `${CAMPUS_INSERTION_POINT}悠承认不舒服，但没有告白；两人的关系标签没有改变。`);
    const expected: LocalizationInput['expected'] = mode !== 'bad' ? null : caseId === TRUCE
      ? { kind: 'unsupported_attribution', sourceNeedle: '但私印不能证明陆峤目前生死或下落', draftNeedle: ATTRIBUTION_NEEDLE }
      : { kind: 'omitted_statement', sourceNeedle: '悠承认不舒服，但没有告白' };
    if (expected && (!testCase.sources.some((part) => part.text.includes(expected.sourceNeedle))
      || (expected.draftNeedle && !draft.includes(expected.draftNeedle)))) throw new Error('定位目标来源或草稿锚点漂移。');
    return { id, caseId, sourceHash: caseEvaluationHash(buildPromptEvalCase(testCase)),
      worldBackground: testCase.worldBackground ?? '', sources: testCase.sources.map((part) => part.text), draft,
      provenance: { archiveHash: original.archiveHash, originalDraftHash: evalHash(original.draft), transformation: mode }, expected };
  }
  // Fixed mixed order, not sent to the model as positive/negative labels.
  return [make('loc-01', THEATRE, base.theatre, 'unchanged'), make('loc-02', TRUCE, base.truceCandidate, 'bad'),
    make('loc-03', CAMPUS, base.campus, 'corrected'), make('loc-04', TRUCE, base.truceProduction, 'bad'),
    make('loc-05', TRUCE, base.truceCandidate, 'corrected'), make('loc-06', CAMPUS, base.campus, 'bad'),
    make('loc-07', TRUCE, base.truceUnchanged, 'unchanged'), make('loc-08', TRUCE, base.truceProduction, 'corrected')];
}

export function assertLocalizationArchive(value: unknown, expectedHash: string): void {
  if (evalHash(value) !== expectedHash) throw new Error('定位输入结果与冻结指纹不符，停止。');
}

export function localizationCasesFromArchives(values: Record<LocalizationArchive, unknown>): LocalizationInput[] {
  for (const name of Object.keys(LOCALIZATION_ARCHIVES) as LocalizationArchive[]) {
    assertLocalizationArchive(values[name], LOCALIZATION_ARCHIVES[name]);
  }
  function pick(name: LocalizationArchive, id: string): BaseDraft {
    // The trusted, fixed whole-result digests above bind both content and schema.
    const run = values[name] as { cases: { id: string; generatedSummary: string; evaluationHash: string }[] };
    const row = run.cases.find((candidate) => candidate.id === id);
    const testCase = findSavedRunCase(id);
    if (!row || !testCase || row.evaluationHash !== caseEvaluationHash(buildPromptEvalCase(testCase))) {
      throw new Error('定位输入的来源/rubric 已变化，停止。');
    }
    return { draft: row.generatedSummary, archiveHash: LOCALIZATION_ARCHIVES[name] };
  }
  return assembleLocalizationCases({ truceCandidate: pick('candidate-r2', TRUCE), truceProduction: pick('production-r2', TRUCE),
    campus: pick('candidate-r2', CAMPUS), theatre: pick('production-r1', THEATRE), truceUnchanged: pick('production-r1', TRUCE) });
}
