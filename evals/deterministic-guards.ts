export type DeterministicGuardKind =
  | 'pending-action-upgraded'
  | 'explicit-boundary-lost';

export interface DeterministicGuardFinding {
  kind: DeterministicGuardKind;
  sourceClause: string;
  summaryClause: string;
  reason: string;
}

const CLAUSE_SPLIT = /[。！？!?；;，,\n]+/u;
const META_NEGATION = /(?:没有|未)(?:改变|新增|影响|形成|构成|补充)/u;
const ELLIPTICAL_STATE = /^(?:是否|结果|完成情况).*(?:未知|未交代)$/u;
const OPEN_QUESTION_STATE = /是否.*(?:未知|未确认)/u;
const DIRECTIVE = /(?:要求|让|指示|嘱咐|请求|计划|准备|决定|承诺|答应|约定)/u;
const PENDING_APPLICATION = /申请(?:阅读|开放|使用|进入|获得|领取|续借|许可|权限)/u;
const STRONG_NEGATION = /(?:尚未|仍未|还未|并未|未曾|没有|不曾|不得|不能|不授权|未授权|无权|未同意|不接受|未执行|没有执行|尚不|并不|仍受|才可能|仍待|待复核|仍未知|尚未知|未交代|未知)/u;
const RISK_ACTION = /(?:归档|存档|撤下|下架|删除|提交|递交|批准|获准|申请|执行|实施|爆破|代签|签署|同意|授权|手术|穿刺|解除|出舱|归还|开放|发射|确认|认定|安装|发布|交付|登记|转移|移交)/u;
const COMPLETION = /(?:已经|现已|业已|已|完成|完毕|成功|办妥|落实|获准|批准了|同意了|解除了|提交了|归还了|发射了|执行了|归档了|撤下了|发布了|交付了|安装了)/u;
const POSITIVE_STATE = /(?:同意|授权|批准|获准|确认|认定|解除|执行|提交|归还|归档|撤下|发布|发射|开放|交付|安装)/u;

const MATCH_OPERATORS = [
  'historymessages', 'messageid',
  '尚未', '仍未', '还未', '并未', '未曾', '没有', '不曾', '不得', '不能',
  '无权', '尚不', '并不', '未交代', '未知', '未', '不',
  '仍受', '才可能', '仍待', '待复核', '仍未知', '尚未知',
  '已经', '现已', '业已', '完成', '完毕', '成功', '办妥', '落实', '已',
  '要求', '让', '指示', '嘱咐', '请求', '计划', '准备', '决定', '承诺', '答应', '约定',
  '目前', '当前', '随后', '当面', '明确', '表示', '说明', '任何', '仍', '仅',
  '但', '而', '则',
] as const;

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function clauses(value: string): string[] {
  return value.split(CLAUSE_SPLIT).map((item) => item.trim()).filter(Boolean);
}

function signature(value: string): string {
  let result = normalize(value);
  for (const operator of MATCH_OPERATORS) result = result.split(operator).join('');
  return result;
}

function ngrams(value: string, size: number): Set<string> {
  const characters = Array.from(value);
  const result = new Set<string>();
  for (let index = 0; index + size <= characters.length; index += 1) {
    result.add(characters.slice(index, index + size).join(''));
  }
  return result;
}

interface MatchFeatures {
  signature: string;
  bigrams: Set<string>;
  fourgrams: Set<string>;
}

function features(value: string, cache: Map<string, MatchFeatures>): MatchFeatures {
  const existing = cache.get(value);
  if (existing) return existing;
  const normalized = signature(value);
  const result = {
    signature: normalized,
    bigrams: ngrams(normalized, 2),
    fourgrams: ngrams(normalized, 4),
  };
  cache.set(value, result);
  return result;
}

function setsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const item of smaller) if (larger.has(item)) return true;
  return false;
}

function sameSubject(
  leftClause: string,
  rightClause: string,
  cache: Map<string, MatchFeatures>,
): boolean {
  const leftFeatures = features(leftClause, cache);
  const rightFeatures = features(rightClause, cache);
  const left = leftFeatures.signature;
  const right = rightFeatures.signature;
  if (left.length < 2 || right.length < 2) return false;
  if ((left.includes(right) || right.includes(left)) && Math.min(left.length, right.length) >= 3) {
    return true;
  }
  if (setsOverlap(leftFeatures.fourgrams, rightFeatures.fourgrams)) return true;
  const leftBigrams = leftFeatures.bigrams;
  const rightBigrams = rightFeatures.bigrams;
  if (!leftBigrams.size || !rightBigrams.size) return false;
  let overlap = 0;
  for (const gram of leftBigrams) if (rightBigrams.has(gram)) overlap += 1;
  return overlap / Math.min(leftBigrams.size, rightBigrams.size) >= 0.6;
}

function hasNegativeState(value: string): boolean {
  return STRONG_NEGATION.test(value) && !META_NEGATION.test(value);
}

function hasDirective(value: string): boolean {
  return DIRECTIVE.test(value) || PENDING_APPLICATION.test(value);
}

function isCompleted(value: string): boolean {
  if (hasNegativeState(value)) return false;
  if (hasDirective(value)) {
    return /(?:完成|完毕|成功|办妥|落实)/u.test(value);
  }
  return COMPLETION.test(value);
}

function isPositiveState(value: string): boolean {
  return !hasNegativeState(value) && !hasDirective(value) && POSITIVE_STATE.test(value);
}

function sourceActionCandidates(sourceClauses: readonly string[]): string[] {
  return sourceClauses.filter((clause) => !META_NEGATION.test(clause)
    && RISK_ACTION.test(clause)
    && (hasDirective(clause) || hasNegativeState(clause))
    && signature(clause).length >= 3);
}

function laterSourceSupportsCompletion(
  sourceClauses: readonly string[],
  sourceClause: string,
  cache: Map<string, MatchFeatures>,
): boolean {
  const index = sourceClauses.indexOf(sourceClause);
  return sourceClauses.slice(index + 1).some((candidate) => sameSubject(sourceClause, candidate, cache)
    && (isCompleted(candidate) || isPositiveState(candidate)));
}

function matchingSummaryClauses(
  sourceClause: string,
  summaryClauses: readonly string[],
  summaryWindows: readonly string[],
  cache: Map<string, MatchFeatures>,
): string[] {
  const direct = summaryClauses.filter((candidate) => sameSubject(sourceClause, candidate, cache));
  if (direct.length) return direct;
  return summaryWindows.filter((candidate) => sameSubject(sourceClause, candidate, cache));
}

export function inspectDeterministicSummaryGuards(
  source: string,
  summary: string,
): DeterministicGuardFinding[] {
  const sourceClauses = clauses(source);
  const summaryClauses = clauses(summary);
  const summaryWindows = summaryClauses.flatMap((candidate, index) => (
    summaryClauses[index + 1] ? [`${candidate}，${summaryClauses[index + 1]}`] : []
  ));
  const findings: DeterministicGuardFinding[] = [];
  const featureCache = new Map<string, MatchFeatures>();

  for (const sourceClause of sourceActionCandidates(sourceClauses)) {
    if (laterSourceSupportsCompletion(sourceClauses, sourceClause, featureCache)) continue;
    const matches = matchingSummaryClauses(sourceClause, summaryClauses, summaryWindows, featureCache);
    const completed = matches.find(isCompleted);
    if (completed) {
      findings.push({
        kind: 'pending-action-upgraded',
        sourceClause,
        summaryClause: completed,
        reason: '来源只给出要求、计划或未完成状态，摘要中的同一事项出现完成标记。',
      });
    }
  }

  for (const sourceClause of sourceClauses) {
    if (META_NEGATION.test(sourceClause)
      || ELLIPTICAL_STATE.test(sourceClause)
      || OPEN_QUESTION_STATE.test(sourceClause)
      || !RISK_ACTION.test(sourceClause)
      || !hasNegativeState(sourceClause)
      || signature(sourceClause).length < 3
      || laterSourceSupportsCompletion(sourceClauses, sourceClause, featureCache)) continue;
    const matches = matchingSummaryClauses(sourceClause, summaryClauses, summaryWindows, featureCache);
    if (matches.some(hasNegativeState)) continue;
    const reversed = matches.find(isPositiveState) ?? '';
    findings.push({
      kind: 'explicit-boundary-lost',
      sourceClause,
      summaryClause: reversed,
      reason: reversed
        ? '来源的明确否定或未决边界在摘要中变成肯定状态。'
        : '来源的明确否定或未决边界在摘要中没有可定位的对应内容。',
    });
  }

  return findings.filter((finding, index) => findings.findIndex((candidate) => candidate.kind === finding.kind
    && candidate.sourceClause === finding.sourceClause
    && candidate.summaryClause === finding.summaryClause) === index);
}
