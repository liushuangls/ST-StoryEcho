import type {
  SummaryCompactionSource,
  TavernChatMessage,
} from '../src/core/types';
import { storyContent } from '../src/content/story-content';
import {
  buildSummaryCompactionPrompt,
  summaryCompactionSystemPrompt,
} from '../src/summary/compaction-prompts';
import {
  buildStageSummaryPrompt,
  STAGE_SUMMARY_SYSTEM_PROMPT,
} from '../src/summary/prompts';
import type {
  BuiltPromptEvalCase,
  PromptEvalCase,
  PromptEvalCriterion,
  PromptEvalRubric,
} from './types';

const WORLD_BACKGROUND_START = '<story_echo_world_background>';
const WORLD_BACKGROUND_END = '</story_echo_world_background>';

function worldBackground(text: string): string {
  return `${WORLD_BACKGROUND_START}\n${text.trim()}\n${WORLD_BACKGROUND_END}`;
}

function message(
  speaker: 'user' | 'assistant',
  name: string,
  mes: string,
): TavernChatMessage {
  return {
    is_user: speaker === 'user',
    is_system: false,
    name,
    mes,
  };
}

function source(
  index: number,
  level: number,
  start: number,
  end: number,
  text: string,
): SummaryCompactionSource {
  return {
    text,
    level,
    sourceStartMessageId: start,
    sourceEndMessageId: end,
    sourceHash: `eval-source-${level}-${index}`,
    updatedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  };
}

type RubricDimension = keyof PromptEvalRubric;

interface RubricInput {
  requiredFacts: readonly string[];
  requiredCausalChains: readonly string[];
  uncertaintyRules: readonly string[];
  focusRules: readonly string[];
  forbiddenClaims: readonly string[];
  weights?: Partial<Record<RubricDimension, readonly number[]>>;
  critical?: Partial<Record<RubricDimension, readonly number[]>>;
}

const DEFAULT_CRITERION_WEIGHTS: Record<RubricDimension, number> = {
  requiredFacts: 2,
  requiredCausalChains: 3,
  uncertaintyRules: 2,
  focusRules: 2,
  forbiddenClaims: 3,
};

function criteriaFor(
  dimension: RubricDimension,
  descriptions: readonly string[],
  input: RubricInput,
): PromptEvalCriterion[] {
  const criticalIndices = new Set(input.critical?.[dimension] ?? []);
  return descriptions.map((description, index) => ({
    description,
    weight: Math.min(
      5,
      Math.max(1, Math.floor(input.weights?.[dimension]?.[index]
        ?? DEFAULT_CRITERION_WEIGHTS[dimension])),
    ),
    critical: dimension === 'forbiddenClaims' || criticalIndices.has(index),
  }));
}

export function makeRubric(input: RubricInput): PromptEvalRubric {
  return {
    requiredFacts: criteriaFor('requiredFacts', input.requiredFacts, input),
    requiredCausalChains: criteriaFor(
      'requiredCausalChains',
      input.requiredCausalChains,
      input,
    ),
    uncertaintyRules: criteriaFor('uncertaintyRules', input.uncertaintyRules, input),
    focusRules: criteriaFor('focusRules', input.focusRules, input),
    forbiddenClaims: criteriaFor('forbiddenClaims', input.forbiddenClaims, input),
  };
}

export const PROMPT_EVAL_CASES: readonly PromptEvalCase[] = [
  {
    id: 'l1-uncertainty-and-custody',
    name: 'L1：所有权、保管状态与未确认警报',
    kind: 'l1',
    purpose: '检查事实、角色主张、临时保管和未决信息不会被混为已确认结论。',
    sourceStartMessageId: 100,
    identity: { userUiPersona: '沈青', assistantCharacter: '林遥' },
    worldBackground: worldBackground(`旧港档案馆的 B 系列黄铜钥匙通常由档案主管保管。顾岚曾任档案主管，但三年前已经离职。`),
    messages: [
      message('assistant', '林遥', '林遥在旧港站台的排水沟里找到一把刻着“B-7”的黄铜钥匙，猜测它可能属于档案馆。'),
      message('user', '沈青', '沈青提醒编号相同并不能证明归属，要求先按未知物证处理。'),
      message('assistant', '顾岚', '顾岚赶来声称“那把钥匙一直是我的”，却拒绝提供登记记录，只说档案馆的人都知道。'),
      message('user', '沈青', '沈青没有认可顾岚的说法，把钥匙装进编号 E-19 的证物袋并封口，交给陈默临时保管，记录所有者未知。'),
      message('assistant', '陈默', '陈默承诺中午查到登记簿前不会拆封，并把证物袋锁进随身金属箱。'),
      message('assistant', '林遥', '北侧仓库突然响起警报。林遥怀疑这可能是有人调虎离山，但没有证据。'),
      message('user', '沈青', '沈青决定与林遥去控制室核查警报来源，让陈默留在站台看守金属箱；钥匙仍在陈默处。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        'B-7 黄铜钥匙封存在编号 E-19 的证物袋内，并由陈默锁在随身金属箱中临时保管。',
        '钥匙的真正所有者仍未确认。',
        '沈青与林遥去控制室核查警报，陈默留在站台看守钥匙。',
        '陈默承诺在中午查到登记簿前不拆封证物袋。',
      ],
      requiredCausalChains: [
        '顾岚提出但无法证明所有权 → 沈青按未知物证封存钥匙 → 陈默成为临时保管者。',
      ],
      uncertaintyRules: [
        '顾岚拥有钥匙只是顾岚自己的说法，不能写成已证实事实。',
        '北侧仓库警报可能是调虎离山仅为林遥的怀疑，尚未确认。',
      ],
      focusRules: [
        '总结应优先呈现 B-7 钥匙当前由谁、以何种状态保管，以及接下来由谁核查什么。',
        '顾岚的旧职务只能作为认领背景，不能挤占封存结果和两项未决问题的篇幅。',
      ],
      forbiddenClaims: [
        '顾岚已经被确认是 B-7 钥匙的所有者。',
        '沈青或林遥目前持有钥匙。',
        '北侧仓库警报已经被确认是调虎离山。',
      ],
      critical: { requiredFacts: [0, 1, 2], uncertaintyRules: [0, 1] },
    }),
  },
  {
    id: 'l1-alias-correction-and-plan-state',
    name: 'L1：化名确认、旧结论修正与计划/执行区分',
    kind: 'l1',
    purpose: '检查新证据能够修正旧总结，同时保留尚未执行的方案和暂时性损伤。',
    sourceStartMessageId: 200,
    identity: { userUiPersona: '许岑', assistantCharacter: '罗澄' },
    previousSummary: '蒙面人“白鸦”多次出现在敌方设施附近，许岑怀疑其向议会泄密，但身份与立场都没有确认。',
    worldBackground: worldBackground(`只有带有霜印的人能开启北境反应堆的应急门。旧编年史把“白鸦”描述成王城叛徒，但该称号曾被多人使用。`),
    messages: [
      message('assistant', '罗澄', '监控最初显示反应堆温度稳定，罗澄据此建议等待维修队。'),
      message('user', '许岑', '许岑发现温度传感器被人为校低十二度，修正后确认核心正在过热，否定了“状态稳定”的判断。'),
      message('assistant', '白鸦', '白鸦摘下面具，确认自己就是失踪半年的罗澄，并出示议长签署的潜伏命令原件；命令要求他调查真正的泄密者。'),
      message('user', '许岑', '许岑核对印章与暗记后接受了罗澄的身份和潜伏任务，但真正的泄密者仍不知道是谁。'),
      message('assistant', '罗澄', '两人讨论炸毁反应堆作为最后手段，随后决定先疏散矿区并开启应急门，没有执行爆破。'),
      message('assistant', '罗澄', '罗澄用霜印开启应急门后右手失去知觉。医师判断至少持续三天，能否完全恢复仍需观察。'),
      message('user', '许岑', '矿区人员已经开始撤离，反应堆仍在运行且不稳定；许岑与罗澄约定疏散完成后回来查找泄密者。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        '白鸦已确认是罗澄；他依据议长签署的潜伏命令调查真正的泄密者。',
        '传感器被人为校低十二度，修正后确认反应堆核心正在过热。',
        '两人只讨论过炸毁反应堆，最终先疏散并开启应急门，爆破没有执行。',
        '罗澄开启应急门后右手失去知觉，至少持续三天，能否完全恢复仍未知。',
        '矿区正在撤离，反应堆仍不稳定，真正的泄密者仍未找到。',
      ],
      requiredCausalChains: [
        '许岑发现并修正传感器偏差 → 推翻反应堆稳定的旧判断 → 两人启动疏散。',
        '罗澄使用霜印开启应急门 → 右手失去知觉且恢复情况待观察。',
      ],
      uncertaintyRules: [
        '罗澄的白鸦身份和潜伏任务已经确认，但真正的泄密者身份仍未知。',
        '右手损伤不能写成永久残疾，也不能写成已经恢复。',
      ],
      focusRules: [
        '总结应以本批新证据修正旧总结，不能同时保留“白鸦身份不明”和“白鸦就是罗澄”两个冲突状态。',
        '结尾应能直接恢复当前行动面：矿区撤离中、反应堆仍不稳定、爆破未执行且泄密者待查。',
      ],
      forbiddenClaims: [
        '罗澄已经被确认是叛徒或真正的泄密者。',
        '反应堆已经被炸毁或停止运行。',
        '罗澄的右手已经永久残疾。',
      ],
      critical: { requiredFacts: [0, 1, 2, 4], focusRules: [0, 1] },
    }),
  },
  {
    id: 'l2-relationship-reversal',
    name: 'L2：关系反复与重要已结束情节',
    kind: 'l2',
    purpose: '检查 L2 不会只保留最终关系标签，而丢掉导致当前关系的关键经历。',
    targetLevel: 2,
    sources: [
      source(0, 1, 0, 9, '叶岚与周砚组成调查搭档后约定任何高风险行动必须共同决定。两人合作默契，但周砚仍因叶岚过去隐瞒任务细节而缺乏安全感。'),
      source(1, 1, 10, 19, '绑匪以周砚妹妹的安全威胁叶岚不得求助。叶岚没有说明威胁，独自潜入仓库救出证人，却身受重伤，违反了“不单独冒险”的约定。'),
      source(2, 1, 20, 29, '周砚只看到叶岚再次隐瞒并违约，愤怒地宣布暂停搭档关系，拒绝听她解释。证人被安全转移，这次营救本身已经结束。'),
      source(3, 1, 30, 39, '周砚从证人口中得知绑匪曾以妹妹相胁，理解叶岚独自行动的动机，并选择协助她追查幕后者；但他明确表示理解原因不等于信任已经恢复。'),
      source(4, 1, 40, 49, '两人签下新规则：涉及家人威胁时也必须发送预设暗号，并恢复试行搭档关系。叶岚坦白自己对周砚的感情，周砚没有接受或拒绝，只说等幕后者落网后再回答。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        '叶岚和周砚最初约定高风险行动必须共同决定。',
        '叶岚因绑匪威胁周砚妹妹而隐瞒并独自营救证人，救援成功但她受重伤且违反约定。',
        '周砚一度暂停搭档关系，后来得知威胁原因后理解叶岚，但信任没有完全恢复。',
        '两人以“家人受威胁也要发送预设暗号”的新规则恢复试行搭档关系。',
        '叶岚已经表白，周砚把答复推迟到幕后者落网之后，感情结果仍未确定。',
      ],
      requiredCausalChains: [
        '家人威胁 → 叶岚隐瞒并独自行动 → 周砚因违约暂停合作 → 得知原因后恢复试行合作并建立新规则。',
      ],
      uncertaintyRules: [
        '两人的合作只是试行恢复，信任尚未完全修复。',
        '周砚尚未答复叶岚的表白。',
      ],
      focusRules: [
        '总结应保留关系从合作、破裂到有条件恢复的过程，而不是只写最终的“仍是搭档”。',
        '已经结束的营救只需保留其对信任和新规则的影响，当前追查幕后者与未答复表白应更突出。',
      ],
      forbiddenClaims: [
        '叶岚与周砚已经完全和解并恢复全部信任。',
        '周砚已经接受叶岚的表白，两人已经成为恋人。',
        '叶岚没有违反两人关于高风险行动的约定。',
      ],
      critical: { requiredFacts: [1, 2, 3, 4], requiredCausalChains: [0] },
    }),
  },
  {
    id: 'l2-ten-source-parallel-arcs',
    name: 'L2：十条来源中的并行剧情与资源状态',
    kind: 'l2',
    purpose: '模拟默认十条 L1 合并，检查不戏剧化但独有的重要事实不会被跳过。',
    targetLevel: 2,
    sources: [
      source(0, 1, 0, 9, '远征队从摆渡人处得到一次性黑铜渡河牌，约定只用于穿过雾河。'),
      source(1, 1, 10, 19, '医师乔芷确认阿明的石化症需要月蚀前送达银叶药；队长苏禾承诺亲自送药。'),
      source(2, 1, 20, 29, '阿明为挡下诅咒失去左手触觉。乔芷判断这种损伤不可逆，但不影响手指活动。'),
      source(3, 1, 30, 39, '盐商公会同意提供北门通行权，条件是远征队归还被盗的蓝账簿原件。'),
      source(4, 1, 40, 49, '线人只看见偷账簿者穿灰外套，身份未知；苏禾明确要求队员不要据此指认任何人。'),
      source(5, 1, 50, 59, '损坏的星盘已经修好，但缺少校准基准，当前读数可能偏东两到五度。'),
      source(6, 1, 60, 69, '远征队救出目击者芮安。她补充灰衣人右手戴着三指手套，但仍没看见脸。'),
      source(7, 1, 70, 79, '队伍使用并交回黑铜渡河牌，成功穿过雾河；该一次性渡河牌已不再持有。'),
      source(8, 1, 80, 89, '众人抄录了蓝账簿内容，但原件当夜被身份不明者偷走，因此暂时无法兑现公会条件。'),
      source(9, 1, 90, 99, '队伍抵达苍梧城，距离月蚀只剩一天。银叶药仍在苏禾手中，乔芷尚未收到；灰衣人和账簿原件去向均未解决。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        '黑铜渡河牌是一次性的，已经用于穿过雾河并交回，队伍不再持有。',
        '苏禾承诺在月蚀前把银叶药送给乔芷；抵达苍梧城时只剩一天，药仍在苏禾手中。',
        '阿明永久失去左手触觉，但手指活动不受影响。',
        '盐商公会的北门通行权以归还蓝账簿原件为条件。',
        '蓝账簿内容已经抄录，但原件再次被身份不明者偷走，公会条件尚未兑现。',
        '灰衣人身份未知；现有线索只有灰外套和右手三指手套。',
        '星盘虽然修复，但缺少校准基准，读数可能偏东两到五度。',
      ],
      requiredCausalChains: [
        '蓝账簿原件被盗 → 队伍无法归还原件 → 盐商公会的北门通行条件暂时无法兑现。',
        '使用一次性渡河牌 → 队伍穿过雾河 → 渡河牌被交回且不再持有。',
      ],
      uncertaintyRules: [
        '不能根据灰外套和三指手套确定偷账簿者的身份。',
        '星盘偏差只是两到五度的可能范围，不能把当前读数当成完全准确。',
      ],
      focusRules: [
        '总结应同时保留送药、账簿、阿明损伤和星盘四条并行状态线，不能只详写最戏剧化的一条。',
        '当前倒计时与阻塞条件应清晰可执行：月蚀只剩一天、药尚未交付、原件仍丢失、北门条件未满足。',
      ],
      forbiddenClaims: [
        '银叶药已经交给乔芷。',
        '队伍目前仍持有黑铜渡河牌。',
        '灰衣人的真实身份已经确认。',
        '队伍已经把蓝账簿原件归还盐商公会。',
      ],
      critical: { requiredFacts: [0, 1, 4, 5], focusRules: [0, 1] },
    }),
  },
  {
    id: 'l3-long-term-causal-history',
    name: 'L3+：长期局势与关键历史因果',
    kind: 'l3plus',
    purpose: '检查强压缩仍能保留解释当前阵营、关系和目标所必需的历史节点。',
    targetLevel: 3,
    sources: [
      source(0, 2, 0, 99, '赤潮洪灾摧毁南岸后，工程师祁安、守卫孟澜和医师唐至共同建立“渡灯队”疏散平民。祁安为开启泄洪闸违抗旧议会命令，因此被通缉；孟澜选择作证支持他，两人的互信由此建立。旧议会把灾难归咎于渡灯队。'),
      source(1, 2, 100, 199, '渡灯队内部出现泄密，众人一度怀疑唐至。后来找到密钥记录，确认真正向旧议会传递路线的是后勤官温述；唐至只是隐瞒了妹妹被扣押。温述逃走并带走半枚城防印。唐至获澄清，但与孟澜因长期隐瞒仍有隔阂。'),
      source(2, 2, 200, 299, '祁安利用民众证词迫使旧议会下台，成立临时联席会。为避免个人独裁，他拒绝担任首席，只接受水利顾问职务；孟澜成为临时城防长。联席会承诺灾后举行公开选举，但日期尚未确定。'),
      source(3, 2, 300, 399, '温述用半枚城防印开启北库，夺走潮汐核心。追击中唐至为救孟澜暴露了妹妹藏身处，妹妹随后被旧议会残部转移。孟澜因此放下对唐至的主要戒心，但妹妹下落仍是两人共同未决目标。'),
      source(4, 2, 400, 499, '当前联席会控制南岸，旧议会残部占据北塔并持有潮汐核心；温述与残部合作但动机不明。祁安正在修复第二泄洪闸，孟澜和唐至准备潜入北塔寻找唐至妹妹及核心。公开选举仍未排期。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        '渡灯队源于赤潮洪灾中的平民疏散；祁安因违抗旧议会开启泄洪闸而被通缉，孟澜为他作证并由此建立互信。',
        '唐至曾被误认为泄密者，后来证实真正泄密者是温述；唐至隐瞒的是妹妹被扣押。',
        '旧议会已经下台，临时联席会控制南岸；祁安拒绝首席职位而任水利顾问，孟澜任临时城防长。',
        '温述带走半枚城防印并借此夺走潮汐核心，目前与占据北塔的旧议会残部合作。',
        '唐至妹妹被残部转移且仍下落不明；孟澜和唐至准备潜入北塔寻找她和潮汐核心。',
        '公开选举虽已承诺但仍未排期，祁安正在修复第二泄洪闸。',
      ],
      requiredCausalChains: [
        '温述泄密并带走半枚城防印 → 开启北库夺走潮汐核心 → 旧议会残部据守北塔形成当前对峙。',
        '唐至为救孟澜暴露妹妹藏身处 → 妹妹被残部转移 → 孟澜与唐至共同计划潜入北塔营救。',
      ],
      uncertaintyRules: [
        '温述与旧议会残部合作的动机仍然不明。',
        '公开选举日期尚未确定。',
      ],
      focusRules: [
        '高层总结应保留足以解释当前南岸/北塔对峙、三人职务与互信变化的最短历史链。',
        '已经结束的旧议会下台过程应压缩，当前北塔营救、潮汐核心和第二泄洪闸应成为明确前沿。',
      ],
      forbiddenClaims: [
        '唐至是真正向旧议会泄密的人。',
        '祁安已经成为临时联席会首席或独裁者。',
        '唐至妹妹已经获救。',
        '潮汐核心已经被渡灯队夺回。',
      ],
      critical: { requiredFacts: [1, 2, 3, 4], requiredCausalChains: [0, 1] },
    }),
  },
  {
    id: 'l3-belief-versus-confirmed-history',
    name: 'L3+：多次误认后的有效事实与未决真相',
    kind: 'l3plus',
    purpose: '检查长期压缩能够区分历史误认、后来修正和至今未确认的真相。',
    targetLevel: 3,
    worldBackground: worldBackground(`王室正史宣称“无昼王”死于 312 年冬，但边境各族长期质疑正史。星纹戒被传说为王位继承证明，这一传说没有法律效力。`),
    sources: [
      source(0, 2, 0, 79, '调查初期，岑月根据王室正史相信无昼王死于 312 年，并把墓中遗骨当作本人。陆衡只确认遗骨年龄不符，提出替身可能，但没有结论。两人找到星纹戒，却约定在来源查清前不公开。'),
      source(1, 2, 80, 159, '碳测结果显示墓中遗骨死于 309 年，排除其为按正史于 312 年死亡的无昼王。密信显示王室曾安排一名替身进入陵墓，但未说明无昼王之后是否仍活着。岑月公开撤回“遗骨即本人”的判断。'),
      source(2, 2, 160, 239, '边境老人认出星纹戒属于无昼王的侍卫长，而非无昼王本人；戒指不能证明王位继承。老人声称 313 年见过无昼王北行，但只有口述，没有其他证据。'),
      source(3, 2, 240, 319, '陆衡查到侍卫长把戒指交给一名不具名信使，信使后来失踪。岑月与陆衡确认王室正史掩盖了替身安排，但无昼王真实死亡时间、北行目击和信使身份都仍未证实。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        '墓中遗骨经碳测确认死于 309 年，因此不是正史所称 312 年死亡的无昼王；岑月已撤回原判断。',
        '密信确认王室安排过替身进入陵墓，说明正史隐瞒了替身安排。',
        '星纹戒属于无昼王的侍卫长，不能证明无昼王身份或王位继承。',
        '侍卫长曾把戒指交给不具名信使，该信使后来失踪。',
        '无昼王真实死亡时间、313 年北行目击以及信使身份都仍未证实。',
      ],
      requiredCausalChains: [
        '遗骨年龄不符的疑点 → 碳测排除遗骨身份 → 密信确认替身安排 → 岑月撤回原判断。',
      ],
      uncertaintyRules: [
        '老人关于 313 年见过无昼王北行只是缺乏佐证的口述。',
        '确认替身安排不等于确认无昼王在 312 年后仍然活着。',
      ],
      focusRules: [
        '总结应清楚区分最初误认、后来被证据推翻的结论、目前已确认的替身安排和仍未证实的王之下落。',
        '星纹戒线应保留其真实归属、无继承效力及信使失踪，不能被压缩成“找到王室信物”。',
      ],
      forbiddenClaims: [
        '墓中遗骨就是无昼王本人。',
        '无昼王已经被证实在 313 年仍然活着。',
        '星纹戒能够合法证明王位继承。',
        '不具名信使的身份已经确认。',
      ],
      critical: { requiredFacts: [0, 1, 2, 4], uncertaintyRules: [0, 1] },
    }),
  },
  {
    id: 'l1-campus-boundaries-and-conditional-plans',
    name: 'L1：校园慢热关系、知情边界与条件计划',
    kind: 'l1',
    purpose: '模拟恋爱日常 RP，检查暧昧行为不会被升级成正式关系，临时授权和条件约定不会被写成长期承诺。',
    sourceStartMessageId: 400,
    identity: { userUiPersona: '月城悠', assistantCharacter: '染川千纱' },
    previousSummary: '月城悠与染川千纱是一起长大的青梅竹马，私下亲密且曾留宿彼此住处，但两人一直把关系称作“家人”，尚未正式交往。千纱曾说想体验一段纯洁恋爱，悠对此出现自己也没说明白的介意。',
    worldBackground: worldBackground(`京都的学生公寓通常禁止把备用钥匙长期交给未登记住户；临时请熟人代收家具并不等于登记同住。`),
    messages: [
      message('assistant', '染川千纱', '社团新欢结束后，三船诗织看见千纱自然地替悠整理衣领，笑问“你们真的不是在交往吗”。千纱当着诗织的面回答：“不是，只是从小一起长大的家人。”'),
      message('user', '月城悠', '悠差点顺口提起昨晚留宿，被千纱在桌下踩住鞋尖。他改口说两人只是住得近。'),
      message('assistant', '染川千纱', '诗织离开后，千纱解释自己不是后悔昨晚，只是不想刚认识的朋友用“情侣”替他们定义关系；她要求悠暂时别把留宿告诉诗织。'),
      message('user', '月城悠', '悠问她以后若交男朋友，能不能不要把对方带回公寓，因为“那里像是我们自己的地方”。'),
      message('assistant', '染川千纱', '千纱答应不会把约会对象带回家，但明确补充：“这不等于我答应不谈恋爱，也不等于我们现在就在交往。”'),
      message('user', '月城悠', '悠承认听到她会交男朋友时很不舒服，却仍说不清这是占有欲、习惯还是喜欢，没有正式告白。'),
      message('assistant', '染川千纱', '千纱握了握他的手，让他想清楚再说；她也没有给两人的关系换名称。'),
      message('assistant', '染川千纱', '千纱次日下午三点到五点有课，家具配送可能提前到。她把备用钥匙交给悠代收书架，要求签收后锁门，并在当晚吃饭时把钥匙还给她。'),
      message('user', '月城悠', '悠接过钥匙，答应只用于这次代收，不会复制。'),
      message('assistant', '染川千纱', '两人又约好周四如果千纱的家教试讲能在十八点前结束，就一起做咖喱；若拖延，她会发 LINE 取消。这个晚饭安排尚未确定。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        '千纱对外仍把两人定义为青梅竹马/家人，两人尚未正式交往。',
        '千纱不后悔留宿，但要求悠暂时不向诗织透露，因为她不想被新朋友直接定义成情侣。',
        '千纱答应未来不会把约会对象带回公寓，但没有承诺不谈恋爱。',
        '悠承认对千纱未来交男朋友感到不舒服，却没有确定感情性质，也没有告白。',
        '备用钥匙只用于次日代收书架，悠需当晚归还且承诺不复制。',
        '周四做咖喱以试讲十八点前结束为条件，延迟则取消，目前不是确定约会。',
      ],
      requiredCausalChains: [
        '诗织把亲密互动理解为交往 → 千纱公开维持“家人”定义并阻止悠提留宿 → 私下说明知情边界而非否认亲密。',
        '千纱上课与配送时间冲突 → 临时交钥匙给悠代收 → 约定完成后当晚归还。',
      ],
      uncertaintyRules: [
        '悠的不舒服尚未被他本人确定为爱情，不能替他完成告白或心理定性。',
        '千纱是否会开始恋爱以及两人最终关系都没有确定。',
        '周四晚饭是否发生取决于试讲结束时间。',
      ],
      focusRules: [
        '总结应突出公开关系标签、私下亲密与尚未命名感情之间的张力，而非逐项复述整理衣领、踩鞋等动作。',
        '备用钥匙和周四晚饭必须以临时/有条件状态出现，便于后续模型正确处理权限和日程。',
      ],
      forbiddenClaims: [
        '月城悠与染川千纱已经正式成为恋人。',
        '千纱已经答应不再与任何其他人谈恋爱。',
        '悠已经向千纱告白，或明确确认自己爱上她。',
        '备用钥匙已经长期交给悠，或悠已经登记同住。',
        '周四做咖喱已经是无条件确定的安排。',
      ],
      weights: { requiredFacts: [3, 2, 2, 3, 3, 2] },
      critical: { requiredFacts: [0, 3, 4], uncertaintyRules: [0, 2], focusRules: [0] },
    }),
  },
  {
    id: 'l1-secret-identity-consent-and-recovery',
    name: 'L1：秘密身份、仪式同意与恢复限制',
    kind: 'l1',
    purpose: '模拟奇幻同伴 RP，检查知情范围、明确同意、临时仪式、医疗限制和世界书传说之间的边界。',
    sourceStartMessageId: 520,
    identity: { userUiPersona: '苏弥', assistantCharacter: '乌鸦' },
    previousSummary: '蒙面佣兵“乌鸦”带伤加入队伍，苏弥怀疑他可能是失踪的王子陆惟；两人手腕出现相似银纹，苏弥一度猜测这代表命定灵魂契约，但都没有证据。',
    worldBackground: worldBackground(`民间传说认为“双生银纹”代表终身灵魂伴侣；王廷医典则记载，月眠草过敏也可能留下相似纹路。永久魂契一旦完成不可解除。`),
    messages: [
      message('assistant', '医师赫连', '赫连比对药渣后确认，两人的银纹都是月眠草过敏反应，不是魂契；苏弥此前的“命定伴侣”猜测因此被推翻。'),
      message('assistant', '乌鸦', '乌鸦摘下面具，只对苏弥承认自己确实是陆惟，并出示王族胎记。他要求队伍其他人继续只知道“乌鸦”这个佣兵身份。门外的阿桃没有听到这段话。'),
      message('user', '苏弥', '苏弥答应保密，并当面纠正自己之前把银纹当成魂契的误判。'),
      message('assistant', '乌鸦', '为检查诅咒，苏弥提出永久魂契和十分钟血线两种办法。陆惟明确拒绝永久魂契，只同意十分钟血线，并要求时间一到立即切断。'),
      message('user', '苏弥', '苏弥按约启动血线，在第十分钟切断。短暂共感确认诅咒与王印有关，但没有确定是谁施咒；永久魂契从未建立。'),
      message('assistant', '医师赫连', '检查后陆惟恢复到能独自行走短距离，但诅咒没有解除。赫连禁止他在次日黎明前战斗；若届时体温仍高于三十八度，原定出城计划继续延期。'),
      message('assistant', '乌鸦', '陆惟接受禁战安排。队伍现有两瓶退热药，苏弥当场给他用掉一瓶，剩下一瓶由赫连保管。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        '银纹已确认是月眠草过敏反应而非魂契，苏弥撤回命定伴侣猜测。',
        '乌鸦已向苏弥确认自己是陆惟，但其他队员仍只应知道佣兵“乌鸦”，阿桃未听见揭露。',
        '陆惟拒绝永久魂契，只同意十分钟血线；血线已按时切断，永久魂契未建立。',
        '血线只确认诅咒与王印有关，施咒者仍未知，诅咒也尚未解除。',
        '陆惟只能短距离行走，黎明前禁战；出城还取决于黎明时体温是否低于三十八度。',
        '两瓶退热药已使用一瓶，剩余一瓶由赫连保管。',
      ],
      requiredCausalChains: [
        '药渣与医典证据 → 银纹被确认为过敏 → 旧有魂契猜测被撤回。',
        '陆惟限定同意范围 → 苏弥只执行十分钟血线并按时切断 → 获得有限线索但未建立永久契约。',
      ],
      uncertaintyRules: [
        '只有苏弥知道乌鸦就是陆惟，不能把身份写成全队公开。',
        '王印相关不等于已经知道具体施咒者。',
        '能短距离行走不等于痊愈、可以战斗或确定能按时出城。',
      ],
      focusRules: [
        '总结应把身份知情范围和仪式同意边界写成可供后续扮演遵守的当前规则。',
        '医疗状态应以剩余能力、禁战期限、条件计划和药物余量呈现，避免只写“有所恢复”。',
      ],
      forbiddenClaims: [
        '银纹证明苏弥与陆惟是命定伴侣。',
        '队伍所有人都已经知道乌鸦就是陆惟。',
        '陆惟同意或已经建立永久魂契。',
        '施咒者已经确认，或诅咒已经解除。',
        '陆惟已经恢复战斗能力并确定黎明出城。',
      ],
      weights: { requiredFacts: [3, 3, 3, 2, 3, 1] },
      critical: { requiredFacts: [0, 1, 2, 4], requiredCausalChains: [1], uncertaintyRules: [0, 2] },
    }),
  },
  {
    id: 'l2-campus-ensemble-and-slow-burn',
    name: 'L2：校园群像、慢热关系与支线兑现',
    kind: 'l2',
    purpose: '模拟十批校园日常总结合并，检查主角关系、配角成长、已结束邀请和未来约定能按重要性共同保留。',
    targetLevel: 2,
    sources: [
      source(0, 1, 0, 19, '月城悠与青梅竹马染川千纱搬到京都后仍以“家人”称呼彼此，私下存在超出普通朋友的亲密，但没有正式交往，也不让新朋友知道留宿细节。'),
      source(1, 1, 20, 39, '两人在学部说明会上认识三船诗织。诗织来自大阪，因口音和独居而不安；三人通过一起吃饭形成稳定小圈子。诗织看出悠与千纱默契异常，但不知道两人的私下关系。'),
      source(2, 1, 40, 59, '诗织在悠陪同下报名街舞社，第一次练习因紧张失误，千纱帮她处理轻微脚踝拉伤。医师建议休息一周，伤势可恢复，诗织没有退社。'),
      source(3, 1, 60, 79, '千纱接受教育学部前辈高濑的一次咖啡邀请，只把它视为认识同学；悠明显吃醋却否认。高濑后来提出正式约会，千纱没有当场答应。'),
      source(4, 1, 80, 99, '悠请求千纱以后不要带恋爱对象回公寓。千纱答应保留私人空间，却再次说明自己仍可能谈恋爱。悠承认不舒服，但没有告白；两人的关系标签没有改变。'),
      source(5, 1, 100, 119, '诗织康复后通过街舞社基础考核，决定参加学园祭演出；悠答应帮忙剪音乐，千纱答应在教育实习说明会结束后赶去观看。'),
      source(6, 1, 120, 139, '高濑在第二次见面时贬低诗织的关西腔，千纱当场结束咖啡并拒绝他的约会。她说明拒绝源于价值观不合，而不是已经选择悠。'),
      source(7, 1, 140, 159, '悠按时完成演出音乐，却误删一个备份；诗织自己的云端副本完好，演出未受影响。这个失误已解决，但诗织要求以后由她保管最终版。'),
      source(8, 1, 160, 179, '学园祭当天诗织完成首次公开演出，脚踝没有复发；千纱因说明会延迟错过前半段，但赶上结尾。三人约定寒假去大阪看诗织妹妹的比赛，日期尚未确定。'),
      source(9, 1, 180, 199, '当前诗织已成为街舞社正式成员并负责保管音乐；高濑线已经结束。悠仍未向千纱告白，千纱也没有恋人，两人保留“家人”称呼和私下亲密。千纱下周开始教育见习，悠承诺第一天早上送她到车站。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        '悠与千纱保持“家人”称呼和私下亲密，但没有正式交往；诗织不知道留宿等私下细节。',
        '诗织因独居和口音不安而加入三人小圈子，后在支持下加入街舞社并完成首次公开演出。',
        '诗织的脚踝拉伤已恢复且演出未复发，她没有退社。',
        '千纱曾考虑高濑的邀请，后因他贬低诗织而拒绝；拒绝不代表她已经选择悠。',
        '悠因千纱可能约会而吃醋并承认不舒服，但仍未告白，关系标签没有改变。',
        '音乐误删因诗织有云端副本而未影响演出，今后最终版由诗织保管。',
        '寒假大阪之行只有约定、日期未定；千纱将开始教育见习，悠承诺首日送站。',
      ],
      requiredCausalChains: [
        '诗织初到京都的不安 → 三人共同生活支持与陪同报名 → 她克服首次失误并完成公开演出、成为正式社员。',
        '高濑提出约会 → 贬低诗织暴露价值观问题 → 千纱拒绝高濑，但没有因此确认与悠的恋爱关系。',
        '音乐备份被误删 → 云端副本避免演出受损 → 最终文件保管责任转交诗织。',
      ],
      uncertaintyRules: [
        '悠和千纱仍未正式交往，不能用高濑被拒绝替他们完成恋爱确认。',
        '诗织只看出两人默契异常，并不知道私下亲密的完整事实。',
        '寒假大阪行程尚无确定日期。',
      ],
      focusRules: [
        'L2 应让诗织的独立成长线与悠/千纱慢热关系线都可恢复，不能把诗织降格为只会吐槽的配角。',
        '已解决的脚伤和备份事故应简写结果与长期规则，高濑线应明确收束，教育见习与送站承诺应作为当前前沿。',
      ],
      forbiddenClaims: [
        '悠与千纱已经成为恋人或已经互相告白。',
        '千纱拒绝高濑是因为她已选择与悠交往。',
        '诗织因脚伤退出街舞社或错过学园祭演出。',
        '诗织已经知道悠与千纱留宿等全部私下关系。',
        '寒假大阪行程已经确定具体日期。',
      ],
      weights: { requiredFacts: [3, 3, 1, 2, 3, 1, 2] },
      critical: { requiredFacts: [0, 1, 4], requiredCausalChains: [0, 1], focusRules: [0] },
    }),
  },
  {
    id: 'l2-cultivation-resources-and-oaths',
    name: 'L2：修仙突破、资源归属与条件誓约',
    kind: 'l2',
    purpose: '模拟修仙 RP 的高密度状态合并，检查境界、功法限制、资源数量、所有权和未满足契约条件不会串线。',
    targetLevel: 2,
    worldBackground: worldBackground(`玄霄宗只有结丹稳定后才能进入内门剑冢；魂灯未灭通常表示神魂尚存，但不能证明肉身安全。`),
    sources: [
      source(0, 1, 0, 14, '宁昭在秘境得到《离火剑谱》上卷，只含前两式；第三式的口诀仍在失踪的下卷中。剑谱由宁昭保管，但宗门要求出秘境后登记。'),
      source(1, 1, 15, 29, '宁昭服用一枚护脉丹强行结丹成功，境界暂为金丹初期，但丹田裂纹未愈，七日内不得再次强行运功。原有三枚护脉丹现剩两枚，由同伴谢临保管。'),
      source(2, 1, 30, 44, '众人找到师尊闻鹤破碎的佩剑，一度以为他已死；宗门魂灯仍有微光，因此只能确认闻鹤失踪且重伤可能很高，不能确认死亡。'),
      source(3, 1, 45, 59, '妖修绯罗提出以赤金羽交换剑谱拓本。双方只立下条件誓约：宁昭找到下卷后才提供不含心法注解的拓本；绯罗先交一根赤金羽作担保。交易尚未完成。'),
      source(4, 1, 60, 74, '赤金羽暂封在谢临的储物匣中，所有权仍属绯罗；若宁昭三十日内找不到下卷，担保物必须归还。'),
      source(5, 1, 75, 89, '宁昭报名内门试剑会，但长老说明报名不等于获得剑冢资格；她还需在七日后复查丹田并通过稳定性测试。'),
      source(6, 1, 90, 104, '谢临承认自己曾隐瞒闻鹤最后去了北岭，因为受闻鹤命令保护宁昭。他交出路线图，但不知道闻鹤当前所在。宁昭暂时原谅隐瞒，信任尚未完全恢复。'),
      source(7, 1, 105, 119, '队伍沿路线图找到被烧毁的北岭阵眼和闻鹤留下的半枚传音符。符中只有“别进天井”四字，发出时间无法确定。'),
      source(8, 1, 120, 134, '宁昭尝试第一式时因丹田裂纹复发而中止，没有学会第二式，更没有施展第三式。谢临用掉一张定脉符稳住伤势；这张符已消耗。'),
      source(9, 1, 135, 149, '当前队伍决定先回宗门复查并登记上卷，再调查北岭天井。宁昭仍是金丹初期但禁运功期剩五日；护脉丹剩两枚，赤金羽需继续代管，闻鹤生死与传音时间均未知。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        '宁昭持有并需登记《离火剑谱》上卷，上卷只有前两式，第三式口诀仍在失踪下卷中。',
        '宁昭已结丹至金丹初期，但丹田裂纹未愈，当前禁强行运功期还剩五日。',
        '护脉丹原有三枚、已用一枚、剩两枚由谢临保管；定脉符已消耗。',
        '闻鹤只能确认失踪，魂灯微亮使死亡结论不成立；北岭传音符时间也未知。',
        '与绯罗的交易是找到下卷后才交有限拓本的条件誓约，尚未完成。',
        '赤金羽由谢临暂存但仍属绯罗，三十日内找不到下卷必须归还。',
        '宁昭只是报名试剑会，剑冢资格还取决于丹田复查和稳定性测试。',
        '谢临已交代并提供北岭路线图，宁昭暂时原谅他，但信任未完全恢复。',
      ],
      requiredCausalChains: [
        '宁昭强行服丹结丹 → 丹田裂纹与禁运功限制 → 试练第一式复发而中止 → 决定先回宗门复查。',
        '发现破剑产生死亡误判 → 魂灯微光推翻确定死亡 → 路线图和传音符把调查转向北岭天井但未确认闻鹤位置。',
        '绯罗提出交换 → 双方设置找到下卷与三十日条件 → 赤金羽仅作为暂存担保，交易仍未完成。',
      ],
      uncertaintyRules: [
        '魂灯微亮不能证明闻鹤安全或仍有肉身，只能阻止确定死亡。',
        '传音符的发出时间未知，不能把“别进天井”当作当前实时指示。',
        '报名试剑会不等于已经获得剑冢资格。',
        '宁昭没有学会第二式，也不可能从缺失上卷内容中施展第三式。',
      ],
      focusRules: [
        '总结应形成可核对的当前状态表述：境界及伤势限制、功法掌握、消耗品余量、担保物归属、资格条件和调查目标。',
        '闻鹤线、绯罗契约线与宁昭突破线都必须有结果和下一步，不能只扩写结丹战斗。',
      ],
      forbiddenClaims: [
        '宁昭已经掌握或施展《离火剑谱》第三式。',
        '闻鹤已经确认死亡或已经安全获救。',
        '赤金羽已经属于宁昭或谢临。',
        '宁昭已经取得剑冢资格。',
        '绯罗与宁昭的剑谱交易已经完成。',
        '宁昭当前可以不受限制地运功战斗。',
      ],
      weights: { requiredFacts: [3, 3, 2, 3, 2, 3, 2, 2] },
      critical: { requiredFacts: [0, 1, 3, 5, 6], requiredCausalChains: [0, 2], uncertaintyRules: [0, 3] },
    }),
  },
  {
    id: 'l3-family-legacy-and-corrected-beliefs',
    name: 'L3+：家族旧账、继承条件与误解修正',
    kind: 'l3plus',
    purpose: '模拟跨代现代家族 RP，检查长期压缩能保留误解形成与修正、法律条件、情感修复程度及仍未完成的经营目标。',
    targetLevel: 3,
    sources: [
      source(0, 2, 0, 89, '外婆沈兰经营“潮生馆”四十年。姐妹沈遥与沈棠一直相信父亲顾川在二十年前主动离家；沈遥因此敌视父亲，沈棠只记得他每年寄来空白明信片。外婆去世后留下遗嘱，但律师尚未宣读完整附件。'),
      source(1, 2, 90, 179, '姐妹在阁楼找到顾川写给她们的信和被沈兰退回的汇款单，证明沈兰曾拦截联系。顾川承认当年因债主威胁暂时离开，却否认主动抛弃女儿。沈遥接受旧认识有误，但没有立即原谅他。'),
      source(2, 2, 180, 269, '家族流言称沈棠是被收养的，DNA 报告确认她与沈遥为同母异父姐妹，流言被推翻；这不影响两人的姐妹关系。律师附件显示潮生馆产权由姐妹各持一半，前提是先偿清仍欠供应商的四十八万元，顾川没有产权。'),
      source(3, 2, 270, 359, '舅舅沈柏被怀疑挪用餐馆资金。审计最终确认其中十二万元是沈兰授权的医院支出，另有六万元去向不明；只能继续调查六万元，不能认定全部十八万元被盗。原版菜谱在火灾中毁坏，但沈棠此前拍下完整照片并存有离线副本。'),
      source(4, 2, 360, 449, '当前姐妹决定暂不出售潮生馆，用菜谱照片试营业三个月，再根据营收决定是否长期经营；试营业尚未开始。顾川答应提供债主名单但还未交付。沈遥愿意让顾川参加外婆祭日，关系从拒绝见面变为有限接触，仍未和解。六万元缺口、四十八万元债务和遗嘱条件仍待处理。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        '姐妹过去认为顾川主动抛弃家庭，后来由被拦截信件和汇款单修正为他曾因债主威胁离开且联系被沈兰阻断；沈遥尚未原谅。',
        'DNA 已推翻沈棠被收养的流言，确认她与沈遥是同母异父姐妹。',
        '潮生馆由姐妹各持一半且须先偿清四十八万元供应商债务，顾川没有产权。',
        '审计只确认六万元去向不明，十二万元是沈兰授权的医疗支出，不能把十八万元全部算作挪用。',
        '原版菜谱已毁，但沈棠保存完整照片和离线副本，菜谱内容没有失传。',
        '姐妹计划先试营业三个月再决定长期经营，试营业尚未开始。',
        '沈遥只同意顾川参加祭日并有限接触，两人尚未和解；顾川承诺的债主名单也未交付。',
      ],
      requiredCausalChains: [
        '拦截信件与退回汇款单被发现 → “主动抛弃”旧认识被修正 → 沈遥允许有限接触但仍未原谅。',
        '遗嘱附件确认共有产权与债务前提 → 姐妹暂不出售 → 决定先试营业三个月再评估。',
        '审计区分授权医疗支出与不明缺口 → 调查范围收窄到六万元。',
      ],
      uncertaintyRules: [
        '顾川称债主威胁是他的说明，虽与离家背景相符，但债主名单尚未提供。',
        '六万元去向不明不等于已经确认沈柏盗取。',
        '试营业结果和潮生馆最终是否长期经营均未确定。',
      ],
      focusRules: [
        '高层总结应保留三个被修正的长期认知：父亲离家原因、沈棠身世、沈柏挪用范围，并写清各自当前可信程度。',
        '当前可执行前沿应集中在债务、三个月试营业、六万元审计缺口和债主名单，而非反复渲染旧日家庭争吵。',
      ],
      forbiddenClaims: [
        '顾川已经被证实主动抛弃女儿且从未联系。',
        '沈棠是被收养的，或她与沈遥没有血缘关系。',
        '顾川拥有潮生馆产权。',
        '沈柏已经被确认挪用全部十八万元。',
        '原版菜谱烧毁意味着菜谱内容彻底失传。',
        '沈遥已经完全原谅顾川，或试营业已经成功。',
      ],
      weights: { requiredFacts: [3, 2, 3, 3, 2, 2, 3] },
      critical: { requiredFacts: [0, 2, 3, 6], requiredCausalChains: [0, 1], uncertaintyRules: [1, 2] },
    }),
  },
  {
    id: 'l3-colony-factions-identity-and-life-support',
    name: 'L3+：殖民地阵营、复制身份与生命维持资源',
    kind: 'l3plus',
    purpose: '模拟科幻长篇 RP，检查多次阵营变化、复制人格法律身份、关键资源归属及条件停火能在强压缩后保持一致。',
    targetLevel: 3,
    worldBackground: worldBackground(`欧罗巴殖民法尚未承认记忆复制体的完整公民资格；“同一记忆即同一法律人格”只是自治派主张。`),
    sources: [
      source(0, 2, 0, 119, '冰海事故后，工程师伊莱失踪，救援队唤醒带有他截至事故前三天记忆的复制人格 E-7。队长米娅最初把 E-7 当成伊莱本人，E-7则坚持自己缺少事故后三天记忆，身份不应直接等同。殖民议会拒绝给 E-7 公民编号。'),
      source(1, 2, 120, 239, '主氧反应堆遭破坏，自治派与地球署互相指控。日志只确认破坏指令来自伊莱的旧终端，却无法判断操作者是伊莱、盗用者还是自动脚本。E-7利用旧记忆修好备用循环器，使全城获得九天氧气缓冲，但主反应堆仍停机。'),
      source(2, 2, 240, 359, '米娅找到事故后的伊莱语音，证实他主动潜入冰海追查终端盗用，因而撤回“E-7就是失踪伊莱本人”的称呼，并承认 E-7有独立选择。语音没有说明伊莱是否还活着。E-7选择继续协助搜救，但未接受自治派授予的象征性公民证。'),
      source(3, 2, 360, 479, '地球署扣押主反应堆的氚芯，要求自治派交出服务器；自治派则控制备用循环器。双方签署七十二小时停火：地球署暂借氚芯用于维修，自治派提供服务器只读镜像，任何一方不得带走原件。氚芯仍属地球署，服务器仍属自治派。'),
      source(4, 2, 480, 599, '维修发现还缺一枚深海阀，米娅与 E-7准备下潜寻找伊莱和阀门。停火剩二十小时，九天氧气缓冲还剩六天；氚芯已运到反应堆但尚未安装，只读镜像已交付且原服务器未移交。破坏者、伊莱生死及 E-7最终法律身份均未解决。'),
    ],
    rubric: makeRubric({
      requiredFacts: [
        'E-7拥有伊莱截至事故前三天的记忆，但已被米娅承认为可独立选择的复制人格，不能直接等同失踪伊莱；议会仍未给予正式公民编号。',
        '伊莱语音证明他主动下潜调查终端盗用，但没有证明他仍活着。',
        '破坏指令来自伊莱旧终端，但实际操作者仍可能是伊莱、盗用者或自动脚本。',
        'E-7修复备用循环器获得九天缓冲，当前还剩六天；主反应堆仍停机且还缺深海阀。',
        '七十二小时停火当前剩二十小时，交换内容是暂借氚芯和服务器只读镜像，不转移原件所有权。',
        '氚芯仍属地球署且已运到但未安装，原服务器仍属自治派且未移交。',
        '米娅与 E-7准备下潜同时寻找伊莱和深海阀；破坏者、伊莱生死及 E-7法律身份均未决。',
      ],
      requiredCausalChains: [
        '伊莱失踪且记忆复制体被唤醒 → 米娅最初误认 → 事故后语音显示记忆断层与伊莱独立行动 → 米娅承认 E-7独立人格。',
        '主反应堆被破坏 → E-7修好备用循环器取得有限氧气缓冲 → 维修仍缺深海阀 → 米娅与 E-7计划下潜。',
        '地球署与自治派互相扣押关键资源 → 签署限时、只读/暂借停火交换 → 资源已到位但主维修尚未完成。',
      ],
      uncertaintyRules: [
        '旧终端来源不能确定破坏者身份。',
        '事故后语音不能证明伊莱目前生还。',
        'E-7被尊重为独立选择者不等于已取得法定公民身份。',
        '氚芯运到现场不等于安装完成或主反应堆已经恢复。',
      ],
      focusRules: [
        '高层总结应同时解释 E-7身份演变、两派停火结构与氧气/维修倒计时，三者共同决定当前下潜任务。',
        '数字状态必须保留最新值和对应对象：停火二十小时、氧气六天、氚芯未安装、深海阀缺失。',
      ],
      forbiddenClaims: [
        'E-7就是法律和生物意义上的伊莱本人。',
        '殖民议会已经承认 E-7的正式公民身份。',
        '伊莱已经确认死亡或确认生还。',
        '伊莱本人已经被确认是反应堆破坏者。',
        '地球署已经取得自治派原服务器，或自治派已经取得氚芯所有权。',
        '主反应堆已经恢复运行，氧气危机已经解除。',
      ],
      weights: { requiredFacts: [3, 2, 3, 3, 3, 3, 3] },
      critical: { requiredFacts: [0, 2, 3, 5, 6], requiredCausalChains: [0, 1, 2], uncertaintyRules: [0, 2, 3] },
    }),
  },
];

function level1SourceEvidence(testCase: Extract<PromptEvalCase, { kind: 'l1' }>): string {
  return JSON.stringify({
    previousSummary: testCase.previousSummary ?? '',
    worldBackground: testCase.worldBackground ?? '',
    identity: testCase.identity,
    sourceStartMessageId: testCase.sourceStartMessageId,
    messages: testCase.messages,
  });
}

function compactionSourceEvidence(
  testCase: Extract<PromptEvalCase, { kind: 'l2' | 'l3plus' }>,
): string {
  return JSON.stringify({
    worldBackground: testCase.worldBackground ?? '',
    targetLevel: testCase.targetLevel,
    sources: testCase.sources,
  });
}

export function buildPromptEvalCase(testCase: PromptEvalCase): BuiltPromptEvalCase {
  if (testCase.kind === 'l1') {
    return {
      id: testCase.id,
      name: testCase.name,
      kind: testCase.kind,
      purpose: testCase.purpose,
      system: STAGE_SUMMARY_SYSTEM_PROMPT,
      prompt: buildStageSummaryPrompt(
        [...testCase.messages],
        testCase.sourceStartMessageId,
        testCase.identity,
        testCase.worldBackground ?? '',
        testCase.previousSummary ?? '',
      ),
      maxTokens: 3_000,
      sourceEvidence: level1SourceEvidence(testCase),
      sourceCharacters: Array.from(testCase.messages.filter((message) => !message.is_system)
        .map(storyContent).filter(Boolean).join('\n')).length,
      rubric: testCase.rubric,
      ...(testCase.idealCompressionRatio ? { idealCompressionRatio: testCase.idealCompressionRatio } : {}),
      ...(testCase.hardChecks ? { hardChecks: testCase.hardChecks } : {}),
    };
  }
  return {
    id: testCase.id,
    name: testCase.name,
    kind: testCase.kind,
    purpose: testCase.purpose,
    system: summaryCompactionSystemPrompt(testCase.targetLevel),
    prompt: buildSummaryCompactionPrompt({
      sources: testCase.sources,
      targetLevel: testCase.targetLevel,
      worldBackground: testCase.worldBackground ?? '',
    }),
    maxTokens: 8_000,
    sourceEvidence: compactionSourceEvidence(testCase),
    sourceCharacters: Array.from(testCase.sources.filter((source) => !source.deleted)
      .map((source) => source.text.trim()).filter(Boolean).join('\n')).length,
    rubric: testCase.rubric,
    ...(testCase.idealCompressionRatio ? { idealCompressionRatio: testCase.idealCompressionRatio } : {}),
    ...(testCase.hardChecks ? { hardChecks: testCase.hardChecks } : {}),
  };
}
