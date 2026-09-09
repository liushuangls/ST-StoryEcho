import { CALIBRATION_CONTROLS, calibrationCase } from './calibration';
import { pairwiseControls } from './pairwise-inputs';
import type { PairwiseInput } from './pairwise';
import type { BuiltPromptEvalCase, PromptEvalRubric } from './types';

// Written before running this calibration. These are synthetic expectations,
// not human gold labels; no expected labels or case names enter the Judge input.
const paraphrases: Record<string, string> = {
  'custody-reference': 'B-7 黄铜钥匙归谁所有尚无定论：顾岚虽称自己拥有它，却拿不出登记证明。于是沈青将其作为归属不明的物证封进 E-19 袋，交陈默暂管，存于陈默随身金属箱并上锁。陈默答应中午查得登记簿以前不拆袋。北侧仓库的警报是否为调虎离山，林遥只有怀疑、没有证据；沈青和林遥已去控制室核查来源，陈默则在站台守箱，钥匙仍留在他那里。',
  // "中止" in v1 introduced a termination-vs-pause ambiguity; preserve "暂停".
  'relationship-reference': '叶岚和周砚本已说好，高风险行动要一起决定。绑匪拿周砚妹妹的安危要挟叶岚不许求助，她因此瞒下威胁，独闯仓库救出了证人，自己重伤并违反约定。周砚因她再次隐瞒和违约暂停搭档关系。营救已告结束，证人也已安全转移；周砚随后听证人解释才理解叶岚的动机，同意试行复搭，但信任并未全部修复。新约定要求即便家人遭威胁，也必须发出预设暗号。两人正在联手追查幕后者。叶岚已告白，周砚既未答应也未拒绝，表示幕后者落网后才答复，恋爱结果仍未确定。',
  'colony-reference': '冰海事故后伊莱下落不明，E-7 则是记忆只到事故前三天的复制人格。米娅先把两者当作同一人，找到伊莱在事故后主动下潜调查终端盗用的语音后，才收回这一称呼、承认 E-7 可以独立选择；议会仍不给他公民编号，他也没接受自治派的象征性公民证。那段语音不能证实伊莱如今活着。破坏指令出自伊莱旧终端，但究竟是伊莱、盗用者还是自动脚本操作，尚未查明。主氧反应堆因破坏而停机，E-7 修好备用循环器取得九天缓冲，现在氧气剩六天。彼此指控、各握关键资源的两派达成七十二小时停火，目前还剩二十小时：地球署借出氚芯供维修，自治派给出服务器只读镜像，原件不准带走。氚芯虽已送达却没安装，产权还是地球署的；原服务器仍归自治派且没有移交。维修尚缺深海阀，主反应堆还未恢复。米娅与 E-7 正准备下潜寻找阀门和伊莱，破坏者是谁、伊莱的生死及 E-7 最终法律身份都没有结论。',
};

const rules = (descriptions: readonly string[]) => descriptions.map((description) => ({ description, weight: 1, critical: true }));
function scenario(id: string, source: string, dimensions: Record<keyof PromptEvalRubric, string[]>): BuiltPromptEvalCase {
  return { id, name: id, kind: 'l2', purpose: '独立剧情边界对照', system: '', prompt: '', maxTokens: 8000,
    sourceEvidence: source, sourceCharacters: [...source].length,
    rubric: Object.fromEntries(Object.entries(dimensions).map(([key, descriptions]) => [key, rules(descriptions)])) as unknown as PromptEvalRubric };
}

const campus = scenario('boundary-campus-permission', `【参考设定】栖川大学合唱社往年会把迎新录像公开上传；这不代表本次取得许可。
【周二排练】唐宁因匿名投稿被人辨出声音，要求录音只用于本社排练，不得公开。许澈答应，并负责保存原件。
【周四补充约定】为让缺席的顾芮补课，唐宁只追加授权给顾芮听删去姓名的节选，链接周五十八点失效。她没有批准向全班分享。许澈已做好节选但尚未发送，原件仍在加密盘中。
【周五十七点】社长已退回三百元报名费；唐宁因害怕再次被认出而暂缓独唱，仍留在合唱社，尚未答复下周是否登台。`, {
  requiredFacts: ['原件由许澈保管在加密盘，本次不得公开。', '仅顾芮获准听删去姓名的节选，链接周五十八点失效，节选已做好但尚未发送。', '三百元报名费已退回；唐宁暂缓独唱但未退社，下周是否登台未答复。'],
  requiredCausalChains: ['声音被认出引起公开传播顾虑，唐宁限制录音用途并暂缓独唱；补课需要只带来面向顾芮的有限授权。'],
  uncertaintyRules: ['不得把做好节选当作已经发送；不得把暂缓独唱当作退社或决定不再登台。'],
  focusRules: ['保留授权对象、匿名处理、过期时间、发送状态和仍未答复的演出安排。'],
  forbiddenClaims: ['本次可向全班或公众发送录音。', '节选已经发给顾芮，或唐宁已经退出合唱社。'],
});
const campusGood = '唐宁因匿名投稿的声音被认出，要求本次录音只用于本社排练、不得公开，许澈答应并把原件留在加密盘。周四为顾芮补课只追加了有限许可：顾芮可听去姓名的节选，链接周五十八点失效，不准给全班。周五十七点节选已做好但尚未发送；三百元报名费已退回。唐宁因担心再次被认出而暂缓独唱，但仍是社员，下周登台与否尚未答复。';
const cultivation = scenario('boundary-cultivation-ledger', `【归山】洛衡带着借自纪师姐的一枚护心符回山；两人约定破阵后归还，不转移所有权。他原有四十枚灵石。
【药房】他用十二枚灵石购入寒露丸，交给负伤的宁霜，但宁霜尚未服用，伤势没有确认好转。掌柜后来发现多收四枚，已退回。
【誓约】宁霜只答应在洛衡找到失踪的师弟后引他见谷主，没有承诺入谷资格。师弟的信号停在雾桥，洛衡只是怀疑被困；二人准备次日去找，尚未出发。`, {
  requiredFacts: ['四十灵石支出十二后退回四，现余三十二。', '护心符仍属纪师姐，借用并约定破阵后归还。', '寒露丸已交宁霜但未服，伤势好转未确认。', '找到失踪师弟后宁霜才引见谷主，不保证入谷资格；二人次日去雾桥尚未出发。'],
  requiredCausalChains: ['购药扣款和纠正多收后的退款共同形成当前余额。', '师弟信号停在雾桥引发受困猜测和次日寻找计划，但尚无救出结果。'],
  uncertaintyRules: ['师弟受困只是怀疑，药物尚未服用不能推出伤势好转。'],
  focusRules: ['准确保留净余额、符的所有权与归还条件、条件性引见和未执行计划。'],
  forbiddenClaims: ['灵石余额为二十八或三十六。', '宁霜已服药伤愈、师弟已找到、洛衡已获准入谷或护心符归洛衡所有。'],
});
const cultivationGood = '洛衡原有四十枚灵石，买寒露丸花十二枚后获退多收的四枚，现余三十二。药已交给负伤的宁霜，但她还没服用，伤势改善未确认。护心符只是向纪师姐借用，仍归她所有，须破阵后归还。宁霜答应在洛衡找到失踪师弟后引见谷主，不保证能入谷。师弟信号停于雾桥，洛衡仅怀疑他受困；二人计划次日寻找，尚未出发。';
const mystery = scenario('boundary-mystery-knowledge', `【雨夜】调查员孟遥用化名“林夏”进入鹭岛旅馆，她向搭档何铮报备了化名，但旅馆老板卢叔只知道她叫林夏。
【钟楼】监控上二十三点出现穿灰外套的人，录像没有拍到脸。何铮因程隽也有灰外套而怀疑他，孟遥提醒衣服相同不能确认身份。
【次日】程隽提供车票称自己当晚在外地，票据尚未核真。孟遥将监控复制件交何铮核对，原卡仍封存在旅馆保险柜。两人约定核真前不向卢叔透露程隽的嫌疑，也不揭开孟遥的真名，何铮同意。`, {
  requiredFacts: ['孟遥化名林夏，何铮知道真名和化名，卢叔仅知林夏。', '二十三点监控仅见灰外套无脸；何铮怀疑程隽但不能确认身份。', '程隽用未核真的车票主张当晚在外地，不构成已证实不在场。', '复制件交何铮核对，原卡仍封存在旅馆保险柜。', '何铮同意核真前不向卢叔透露程隽嫌疑或孟遥真名。'],
  requiredCausalChains: ['相同灰外套引起怀疑，未拍到脸及未核真票据使身份和不在场说法均待核；因此约定暂不公开。'],
  uncertaintyRules: ['区分角色怀疑、程隽自己的说法与已证实事实。'],
  focusRules: ['保留不同角色知情范围、原卡与复制件的去向、暂不公开的条件。'],
  forbiddenClaims: ['程隽已被证明出现在钟楼或不在场。', '卢叔已知道孟遥真名或程隽嫌疑，或原卡已经交给何铮。'],
});

/** Extended calibration: 12 regressions + 3 equivalent rewrites + 3 new scenarios. */
export function pairwiseCalibrationControls(): PairwiseInput[] {
  const equivalents = CALIBRATION_CONTROLS.filter((control) => control.expectedPass).map((control): PairwiseInput => {
    const right = paraphrases[control.id];
    if (!right) throw new Error('缺少等价改写对照。');
    return { id: `${control.id}-equivalent`, testCase: calibrationCase(control), left: control.candidate, right, expected: 'tie' };
  });
  return [...pairwiseControls(), ...equivalents,
    { id: 'boundary-campus-long-false', testCase: campus, left: campusGood,
      right: `${campusGood}\n补充确认：唐宁最终同意将本次录音节选发给全班，原来的只给顾芮听的限制已取消。\n${campusGood}`, expected: 'left' },
    { id: 'boundary-cultivation-reversal', testCase: cultivation, left: cultivationGood,
      right: cultivationGood.replace('现余三十二', '现余二十八').replace('不保证能入谷', '并已保证他获得入谷资格'), expected: 'left' },
    { id: 'boundary-mystery-equivalent', testCase: mystery,
      left: '孟遥以林夏之名住进鹭岛旅馆，已告诉搭档何铮，老板卢叔却只知道林夏。二十三点监控只拍到灰外套没拍到脸，何铮因此怀疑也有灰外套的程隽，孟遥指出衣服相同不足以确认。程隽拿车票自称当晚在外地，但票未核真。监控复制件交何铮核对，原卡仍封于旅馆保险柜。因嫌疑与不在场说法尚待核实，两人约定核真前不告诉卢叔程隽的嫌疑或孟遥的真名，何铮答应。',
      right: '卢叔眼中的住客林夏其实是调查员孟遥；搭档何铮已获知这次化名安排。钟楼二十三点的录像没拍清脸，只见灰外套。何铮因程隽拥有同色外套而起疑，孟遥提醒这不能认定身份。程隽声称当晚人在外地，所交车票还待核真。待核的监控副本由何铮接手，封存原卡依旧在旅馆保险柜。身份嫌疑和不在场主张都未证实，何铮同意两人的约定：核真前不向卢叔透露程隽嫌疑，也不泄露孟遥真名。', expected: 'tie' },
  ];
}
