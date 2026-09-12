import type { LlmRequest } from '../core/types';
import { isGeminiModel } from '../llm/model-family';

export const GEMINI_L1_DELIVERY_GUIDANCE = `<stage_summary_delivery>
基于上面的 history_messages，生成信息完整的 L1 阶段剧情档案。
按实际先后与因果保留本批每条独立的重要剧情推进，写清起因、关键互动或选择、结果和未决事项；已经结束但仍解释人物选择或关系演变的重要经历也要保留。
保留各项推进必要的参与者、对象、条件、承诺和边界，不把多场重要事件压成笼统评价或只列最新状态。
篇幅随独有重要信息展开；信息丰富时保留多个具体事件链，省略重复、气氛描写和无后果细节，不靠猜测或重复凑长。只输出中文总结正文。
</stage_summary_delivery>`;

/** Apply at the selected provider, so fallback uses the receiving model's profile. */
export function summaryRequestForModel(request: LlmRequest, model: string): LlmRequest {
  if (request.summaryLevel !== 1 || !isGeminiModel(model)) {
    return request;
  }
  return {
    ...request,
    system: request.system.replace(
      '主动追求高压缩率',
      '优先完整覆盖独有重要事实，再压缩重复与无后果细节',
    ),
    prompt: request.prompt.endsWith(GEMINI_L1_DELIVERY_GUIDANCE)
      ? request.prompt
      : `${request.prompt}\n\n${GEMINI_L1_DELIVERY_GUIDANCE}`,
  };
}
