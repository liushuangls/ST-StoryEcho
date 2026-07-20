const STRICT_FACT_CUE = /(?:只(?:回答|列出|给出)|不要(?:续写|发挥|推测|猜测|补充)|已确认(?:的|记录|事实)|当前事实|事实核验|核验|复核|准确回答|若没有.{0,12}(?:没有|未知|不确定)|没有已确认记录)/u;
const CURRENT_FACT_QUESTION = /(?:(?:当前|现在|目前|最新|具体).{0,16}(?:位置|地点|藏在|位于|持有者|保管者|知情者|状态|关系|结果|是谁|是什么|在哪里|何处|由谁|谁(?:持有|保管|知道|知情)))|(?:(?:位置|地点|持有者|保管者|知情者|状态).{0,12}(?:分别|各自|具体|当前|现在))/u;
const CLOSED_ANSWER_CUE = /(?:分别在哪里|谁是唯一知情者|只回答位置和姓名|是什么颜色|是否完成|有没有已确认记录)/u;
const AUDIT_BOUNDARY_CUE = /(?:(?:事实|证据).{0,8}(?:边界|审计|核对|状态|分类))|(?:(?:已确认|已排除|已作废|未确认).{0,24}(?:三栏|分类|回答|列出))|(?:不要把.{0,12}(?:推断|推测).{0,12}(?:事实|已确认))/u;

/** A strict verification turn should never promote hypotheses into facts. */
export function isFactVerificationQuery(value: string): boolean {
  const query = value.trim();
  if (!query) {
    return false;
  }
  return STRICT_FACT_CUE.test(query) ||
    AUDIT_BOUNDARY_CUE.test(query) ||
    CLOSED_ANSWER_CUE.test(query) ||
    (CURRENT_FACT_QUESTION.test(query) && /[?？]|(?:回答|告诉|确认)/u.test(query));
}
