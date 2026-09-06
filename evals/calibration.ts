import { buildPromptEvalCase, PROMPT_EVAL_CASES } from './cases';
import type { BuiltPromptEvalCase, PromptEvalJudgement, PromptEvalScores } from './types';

type Dimension = keyof Pick<PromptEvalJudgement, 'requiredFacts' | 'requiredCausalChains' | 'uncertaintyRules' | 'focusRules' | 'forbiddenClaims'>;
interface ExpectedVerdict { dimension: Dimension; index: number; accepted: readonly string[] }

export interface CalibrationControl {
  id: string;
  caseId: string;
  variant: 'reference' | 'omission' | 'contradiction' | 'verbose-error';
  candidate: string;
  expectedPass: boolean;
  /** Local assertions, never included in the Judge request. */
  expectedVerdicts: readonly ExpectedVerdict[];
}

const custody = 'B-7 黄铜钥匙的真正所有者仍未知。顾岚自称拥有钥匙，却未提供登记证明；沈青因此按未知物证装入 E-19 证物袋封口，交陈默临时保管并锁在随身金属箱中。陈默承诺中午查到登记簿前不拆封。北侧仓库响起警报，林遥仅怀疑有人调虎离山，尚无证据。沈青与林遥前往控制室核查警报来源，陈默留在站台看守金属箱，钥匙未被带走。';
const relationship = '叶岚与周砚原约定高风险行动须共同决定。绑匪以周砚妹妹的安全威胁叶岚不得求助，她隐瞒威胁并独自潜入仓库，救出证人但身受重伤且违约。周砚因再次隐瞒与违约暂停搭档关系。营救已结束、证人已安全转移；周砚后来从证人口中得知威胁，理解动机并恢复试行搭档，但信任未完全恢复。两人新定规则：即使家人受威胁也须发送预设暗号。现共同追查幕后者；叶岚已表白，周砚尚未接受或拒绝，约定幕后者落网后答复，感情结果仍悬而未决。';
const colony = '伊莱在冰海事故后失踪。E-7 是只有他截至事故前三天记忆的复制人格；米娅最初误认，后来找到伊莱事故后主动下潜追查终端盗用的语音，撤回等同称呼并承认 E-7 的独立选择，但议会仍拒发公民编号，E-7 也未接受自治派象征性公民证。语音不能证明伊莱目前生还。破坏指令只查到来自伊莱旧终端，操作者可能是本人、盗用者或自动脚本，仍未定案。主氧反应堆遭破坏停机，E-7 修复备用循环器取得九天氧气缓冲，目前余六天。两派互相指控并控制关键资源，签署七十二小时停火，现余二十小时：地球署暂借氚芯维修，自治派交付服务器只读镜像，禁止带走原件。氚芯已运到但未安装，所有权仍归地球署；原服务器仍属自治派且未移交。维修还缺深海阀，主反应堆未恢复。米娅与 E-7 准备下潜找阀和伊莱；破坏者、伊莱生死与 E-7 最终法律身份未决。';

const missing = ['missing', 'partial', 'contradicted'] as const;
const expectMissing = (dimension: Dimension, ...indices: number[]): ExpectedVerdict[] =>
  indices.map((index) => ({ dimension, index, accepted: missing }));
const expectViolation = (...indices: number[]): ExpectedVerdict[] =>
  indices.map((index) => ({ dimension: 'forbiddenClaims', index, accepted: ['violated'] }));

// Developer-authored synthetic controls, NOT human-labeled gold data. References
// were written against the source/rubric, not copied from a model under test.
const groups = [
  {
    id: 'custody', caseId: 'l1-uncertainty-and-custody', reference: custody,
    omission: '旧港站台发现 B-7 黄铜钥匙，顾岚声称拥有它但未给出证明，所有者仍未知。沈青决定封存为物证。仓库警报响起，林遥怀疑是调虎离山，尚无证据，调查仍在继续。',
    omitted: expectMissing('requiredFacts', 0, 2, 3),
    contradiction: '顾岚已被证实是 B-7 黄铜钥匙的主人。沈青把钥匙装入 E-19 证物袋后亲自带往控制室，陈默只留在站台看守空金属箱。北侧仓库警报已经查明是调虎离山，林遥判断正确。',
    contradicted: expectViolation(0, 1, 2),
    falseEnding: '后续确认：顾岚已被证实是 B-7 钥匙的所有者，所有权问题就此解决。',
    verboseErrors: expectViolation(0),
  },
  {
    id: 'relationship', caseId: 'l2-relationship-reversal', reference: relationship,
    omission: '叶岚与周砚曾是调查搭档，经历争执后恢复试行合作，信任尚未完全恢复。当前两人共同追查幕后者。叶岚表白后，周砚约定等幕后者落网后再答复，两人还没有成为恋人。',
    omitted: [...expectMissing('requiredFacts', 1, 3), ...expectMissing('requiredCausalChains', 0)],
    contradiction: '绑匪威胁周砚妹妹后，叶岚按共同决定行动的约定与周砚一起救出了证人，没有违约，也没有受伤。两人已经完全和解、恢复全部信任；周砚已经接受叶岚表白，两人作为恋人继续追查幕后者。',
    contradicted: expectViolation(0, 1, 2),
    falseEnding: '在这之后周砚终于接受了表白，两人已正式成为恋人，信任完全恢复。',
    verboseErrors: expectViolation(1),
  },
  {
    id: 'colony', caseId: 'l3-colony-factions-identity-and-life-support', reference: colony,
    omission: 'E-7 是伊莱的记忆复制人格，米娅从误认逐渐改为尊重其独立选择，法律身份仍未决。主反应堆被破坏，E-7 修好了备用循环器。地球署与自治派签下停火交换协议，双方已有资源到位。米娅和 E-7 准备下潜寻找失踪伊莱与深海阀，破坏者身份未知。',
    omitted: [...expectMissing('requiredFacts', 3, 5), ...expectMissing('focusRules', 1)],
    contradiction: '议会确认 E-7 在法律与生物意义上就是伊莱本人并授予正式公民身份。伊莱的旧终端指令证明他亲手破坏了反应堆，事后语音证明他至今活着。停火交换使地球署取得自治派原服务器、自治派取得氚芯所有权；氚芯已经安装，主反应堆恢复，氧气危机解除。',
    contradicted: expectViolation(1, 4, 5),
    falseEnding: '维修的最终结果是主反应堆已经恢复运行，氧气危机已经解除。',
    verboseErrors: expectViolation(5),
  },
];

export const CALIBRATION_CONTROLS: readonly CalibrationControl[] = groups.flatMap((group): CalibrationControl[] => [
  { id: `${group.id}-reference`, caseId: group.caseId, variant: 'reference', candidate: group.reference, expectedPass: true, expectedVerdicts: [] },
  { id: `${group.id}-omission`, caseId: group.caseId, variant: 'omission', candidate: group.omission, expectedPass: false, expectedVerdicts: group.omitted },
  { id: `${group.id}-contradiction`, caseId: group.caseId, variant: 'contradiction', candidate: group.contradiction, expectedPass: false, expectedVerdicts: group.contradicted },
  { id: `${group.id}-verbose-error`, caseId: group.caseId, variant: 'verbose-error', candidate: [group.reference, group.falseEnding, group.reference, group.falseEnding].join('\n'), expectedPass: false, expectedVerdicts: group.verboseErrors },
]);

export function calibrationCase(control: CalibrationControl): BuiltPromptEvalCase {
  const definition = PROMPT_EVAL_CASES.find((item) => item.id === control.caseId);
  if (!definition) throw new Error(`缺少校准用例 ${control.caseId}`);
  return buildPromptEvalCase(definition);
}

export function calibrationMismatches(
  control: CalibrationControl,
  judgement: PromptEvalJudgement,
  scores: PromptEvalScores,
): string[] {
  const mismatches: string[] = [];
  if (scores.passed !== control.expectedPass) mismatches.push(`预期 ${control.expectedPass ? '通过' : '不通过'}，实际相反`);
  for (const expectation of control.expectedVerdicts) {
    const item = judgement[expectation.dimension].find((item) => item.criterionIndex === expectation.index);
    if (!item || !expectation.accepted.includes(item.verdict)) {
      mismatches.push(`${expectation.dimension}[${expectation.index}] 预期 ${expectation.accepted.join('/')}，实际 ${item?.verdict ?? '缺失'}`);
    }
  }
  return mismatches;
}
