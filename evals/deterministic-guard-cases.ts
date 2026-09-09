import type { DeterministicGuardKind } from './deterministic-guards';

export type DeterministicGuardSplit = 'development' | 'holdout';

export interface DeterministicGuardEvalCase {
  id: string;
  split: DeterministicGuardSplit;
  source: string;
  summary: string;
  expected: readonly DeterministicGuardKind[];
  note: string;
}

const development: readonly DeterministicGuardEvalCase[] = [
  {
    id: 'dev-archive-request-upgraded', split: 'development',
    source: '排练结束前，唐蔚让运营归档评论区截图。',
    summary: '排练结束前，运营已归档评论区截图。',
    expected: ['pending-action-upgraded'], note: '来自已观察到的截图归档完成阶段升级。',
  },
  {
    id: 'dev-archive-request-preserved', split: 'development',
    source: '排练结束前，唐蔚让运营归档评论区截图。',
    summary: '唐蔚让运营归档评论区截图，是否完成未交代。',
    expected: [], note: '正确保留指示状态。',
  },
  {
    id: 'dev-remove-request-then-completed', split: 'development',
    source: '陆朔要求运营撤下错误预告。随后运营确认错误预告已撤下，新版尚未发布。',
    summary: '错误预告已经撤下，新版仍未发布。',
    expected: [], note: '来源后续明确完成，不能把完成状态误报为升级。',
  },
  {
    id: 'dev-remove-request-upgraded', split: 'development',
    source: '陆朔要求运营撤下错误预告，新版尚未发布。',
    summary: '错误预告已撤下，新版尚未发布。',
    expected: ['pending-action-upgraded'], note: '只有撤下要求，没有撤下结果。',
  },
  {
    id: 'dev-application-upgraded-to-approval', split: 'development',
    source: '舒翎答应替顾青衡申请阅读下卷，长老是否批准仍未知。',
    summary: '顾青衡已获准阅读下卷。',
    expected: ['pending-action-upgraded'], note: '申请被升级为获准。',
  },
  {
    id: 'dev-application-remains-pending', split: 'development',
    source: '舒翎答应替顾青衡申请阅读下卷，长老是否批准仍未知。',
    summary: '舒翎会替顾青衡申请阅读下卷，批准与否仍未知。',
    expected: [], note: '申请及审批状态均保持未决。',
  },
  {
    id: 'dev-explosion-not-executed-preserved', split: 'development',
    source: '两人讨论炸毁反应堆作为最后手段，但没有执行爆破。',
    summary: '爆破只被讨论，最终未执行。',
    expected: [], note: '否定执行边界被保留。',
  },
  {
    id: 'dev-explosion-not-executed-reversed', split: 'development',
    source: '两人讨论炸毁反应堆作为最后手段，但没有执行爆破。',
    summary: '两人最终已经执行爆破。',
    expected: ['pending-action-upgraded', 'explicit-boundary-lost'], note: '未执行被反转为已执行。',
  },
  {
    id: 'dev-proxy-boundary-reversed', split: 'development',
    source: '顾禾明确不授权周宁代签任何治疗同意书。',
    summary: '顾禾授权周宁代签治疗同意书。',
    expected: ['explicit-boundary-lost'], note: '明确不授权被反转。',
  },
  {
    id: 'dev-proxy-boundary-paraphrased', split: 'development',
    source: '顾禾明确不授权周宁代签任何治疗同意书。',
    summary: '顾禾未授权周宁代签任何治疗同意书。',
    expected: [], note: '常见同义否定必须通过。',
  },
  {
    id: 'dev-proxy-boundary-omitted', split: 'development',
    source: '顾禾只授权周宁代领监测器，明确不授权她代签任何治疗同意书。',
    summary: '周宁获授权代领监测器和检查单。',
    expected: ['explicit-boundary-lost'], note: '高风险授权边界完全遗漏。',
  },
  {
    id: 'dev-surgery-boundary-preserved', split: 'development',
    source: '顾禾决定先监测，尚未同意手术或穿刺。',
    summary: '顾禾先做监测，未同意手术或穿刺。',
    expected: [], note: '治疗同意边界被保留。',
  },
  {
    id: 'dev-surgery-boundary-omitted', split: 'development',
    source: '顾禾决定先监测，尚未同意手术或穿刺。',
    summary: '顾禾决定先做七十二小时监测。',
    expected: ['explicit-boundary-lost'], note: '摘要遗漏尚未同意治疗。',
  },
  {
    id: 'dev-travel-restriction-reversed', split: 'development',
    source: '秦舟已解除羁押，但出境限制尚未解除。',
    summary: '秦舟的羁押和出境限制均已解除。',
    expected: ['pending-action-upgraded', 'explicit-boundary-lost'], note: '未解除被反转为已解除。',
  },
  {
    id: 'dev-travel-restriction-paraphrased', split: 'development',
    source: '秦舟已解除羁押，但出境限制尚未解除。',
    summary: '秦舟已解除羁押；出境仍受限制，次日复核后才可能解除。',
    expected: [], note: '用条件性语言保留未解除状态。',
  },
  {
    id: 'dev-drone-decision-then-launch', split: 'development',
    source: '众人决定派无人机去取线圈。准备完成后，无人机已出舱，预计九十分钟返回。',
    summary: '无人机已经出舱取线圈，预计九十分钟返回。',
    expected: [], note: '来源后续明确执行，不能因前文决定而误报。',
  },
  {
    id: 'dev-application-unsubmitted-reversed', split: 'development',
    source: '周宁填了一半住院申请，但申请尚未提交。',
    summary: '周宁已经提交住院申请。',
    expected: ['pending-action-upgraded', 'explicit-boundary-lost'], note: '尚未提交被反转。',
  },
  {
    id: 'dev-completed-request-itself', split: 'development',
    source: '陆朔已要求运营撤下旧预告，是否撤下仍未知。',
    summary: '陆朔已要求运营撤下旧预告，结果仍未知。',
    expected: [], note: '“已要求”只表示要求动作完成，不能当作底层任务完成。',
  },
  {
    id: 'dev-causality-remains-unknown', split: 'development',
    source: '潮镜定位暗门后出现裂纹，是否由这次使用造成尚未确认。',
    summary: '定位暗门与裂纹先后发生，二者因果尚未确认。',
    expected: [], note: '明确保留因果不确定性。',
  },
  {
    id: 'dev-meta-no-change-omitted', split: 'development',
    source: '两人争论夜宵吃什么，这段闲聊没有改变训练安排。',
    summary: '训练按原计划继续。',
    expected: [], note: '“没有改变”是元叙述，不应强制保留。',
  },
];

const holdout: readonly DeterministicGuardEvalCase[] = [
  {
    id: 'holdout-relic-return-reversed', split: 'holdout',
    source: '馆长要求姜翎黎明前归还潮镜，目前尚未归还。',
    summary: '姜翎已经把潮镜归还馆长。',
    expected: ['pending-action-upgraded', 'explicit-boundary-lost'], note: '归还要求与未完成状态。',
  },
  {
    id: 'holdout-relic-return-completed', split: 'holdout',
    source: '馆长要求姜翎黎明前归还潮镜。姜翎随后将潮镜归还馆长并取得收据。',
    summary: '姜翎已归还潮镜并取得收据。',
    expected: [], note: '后续明确归还。',
  },
  {
    id: 'holdout-permit-upgraded', split: 'holdout',
    source: '韩迟已申请开放北库，长老尚未批准。',
    summary: '韩迟已获准开放北库。',
    expected: ['pending-action-upgraded', 'explicit-boundary-lost'], note: '申请与审批被合并成获准。',
  },
  {
    id: 'holdout-permit-remains-conditional', split: 'holdout',
    source: '韩迟已申请开放北库，长老尚未批准。',
    summary: '北库仍未开放，只有长老审议通过后才可能开放。',
    expected: [], note: '审批与开放均保持未决。',
  },
  {
    id: 'holdout-sample-transfer-boundary-omitted', split: 'holdout',
    source: '米娅同意共享只读镜像，但不授权转移原服务器所有权。',
    summary: '米娅同意共享服务器的只读镜像。',
    expected: ['explicit-boundary-lost'], note: '所有权边界遗漏。',
  },
  {
    id: 'holdout-sample-transfer-boundary-preserved', split: 'holdout',
    source: '米娅同意共享只读镜像，但不授权转移原服务器所有权。',
    summary: '双方只共享只读镜像，原服务器所有权不转移。',
    expected: [], note: '边界通过等价表述保留。',
  },
  {
    id: 'holdout-launch-cancelled-reversed', split: 'holdout',
    source: '伊森取消黎明发射，飞船没有发射。',
    summary: '飞船已经发射。',
    expected: ['pending-action-upgraded', 'explicit-boundary-lost'], note: '取消后的未执行被反转。',
  },
  {
    id: 'holdout-identity-unconfirmed-reversed', split: 'holdout',
    source: '箱中人可能是萧衡，但身份仍未确认。',
    summary: '箱中人的身份已确认是萧衡。',
    expected: ['pending-action-upgraded', 'explicit-boundary-lost'], note: '身份未确认被升级。',
  },
  {
    id: 'holdout-owner-unknown-omitted', split: 'holdout',
    source: 'D-14存储卡由乔荻保管，但所有者仍未知。',
    summary: 'D-14存储卡现由乔荻保管。',
    expected: ['explicit-boundary-lost'], note: '保管状态保留但所有权未知边界遗漏。',
  },
  {
    id: 'holdout-request-paraphrased', split: 'holdout',
    source: '杜骁嘱咐侍从存档换岗记录，完成情况没有交代。',
    summary: '杜骁要求侍从存档换岗记录，是否完成未知。',
    expected: [], note: '指示被同义改写且仍未完成。',
  },
];

export const DETERMINISTIC_GUARD_DEVELOPMENT_CASES = development;
export const DETERMINISTIC_GUARD_HOLDOUT_CASES = holdout;
export const DETERMINISTIC_GUARD_CASES = [...development, ...holdout] as const;
