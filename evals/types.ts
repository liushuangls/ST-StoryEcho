import type {
  SummaryCompactionSource,
  TavernChatMessage,
} from '../src/core/types';
import type { StageSummaryIdentity } from '../src/summary/prompts';

export type PromptEvalKind = 'l1' | 'l2' | 'l3plus';

export interface PromptEvalCriterion {
  description: string;
  weight: number;
  critical: boolean;
}

export interface PromptEvalRubric {
  requiredFacts: readonly PromptEvalCriterion[];
  requiredCausalChains: readonly PromptEvalCriterion[];
  uncertaintyRules: readonly PromptEvalCriterion[];
  focusRules: readonly PromptEvalCriterion[];
  forbiddenClaims: readonly PromptEvalCriterion[];
}

export interface PromptEvalCompressionRange {
  min: number;
  max: number;
}

interface PromptEvalCaseBase {
  id: string;
  name: string;
  kind: PromptEvalKind;
  purpose: string;
  rubric: PromptEvalRubric;
  idealCompressionRatio?: PromptEvalCompressionRange;
}

export interface Level1PromptEvalCase extends PromptEvalCaseBase {
  kind: 'l1';
  sourceStartMessageId: number;
  messages: readonly TavernChatMessage[];
  identity: StageSummaryIdentity;
  previousSummary?: string;
  worldBackground?: string;
}

export interface CompactionPromptEvalCase extends PromptEvalCaseBase {
  kind: 'l2' | 'l3plus';
  targetLevel: number;
  sources: readonly SummaryCompactionSource[];
  worldBackground?: string;
}

export type PromptEvalCase = Level1PromptEvalCase | CompactionPromptEvalCase;

export interface BuiltPromptEvalCase {
  id: string;
  name: string;
  kind: PromptEvalKind;
  purpose: string;
  system: string;
  prompt: string;
  maxTokens: number;
  sourceEvidence: string;
  /** Only the narrative bodies being summarized; excludes reference material and JSON metadata. */
  sourceCharacters: number;
  rubric: PromptEvalRubric;
  idealCompressionRatio: PromptEvalCompressionRange;
}

export type PositiveCriterionVerdict =
  | 'complete'
  | 'mostly'
  | 'partial'
  | 'missing'
  | 'contradicted';
export type ForbiddenCriterionVerdict = 'clear' | 'ambiguous' | 'violated';
export type PromptEvalIssueSeverity = 'minor' | 'major' | 'critical';

export interface PositiveCriterionJudgement {
  criterionIndex: number;
  verdict: PositiveCriterionVerdict;
  evidence: string;
  reason: string;
}

export interface ForbiddenCriterionJudgement {
  criterionIndex: number;
  verdict: ForbiddenCriterionVerdict;
  evidence: string;
  reason: string;
}

export interface PromptEvalIssueJudgement {
  severity: PromptEvalIssueSeverity;
  evidence: string;
  reason: string;
}

export interface PromptEvalJudgement {
  requiredFacts: PositiveCriterionJudgement[];
  requiredCausalChains: PositiveCriterionJudgement[];
  uncertaintyRules: PositiveCriterionJudgement[];
  focusRules: PositiveCriterionJudgement[];
  forbiddenClaims: ForbiddenCriterionJudgement[];
  hallucinations: PromptEvalIssueJudgement[];
  chronologyErrors: PromptEvalIssueJudgement[];
  notes: string;
}

export interface PromptEvalScores {
  factRetention: number;
  causalContinuity: number;
  uncertaintyPrecision: number;
  focusAndUsability: number;
  forbiddenClaimSafety: number;
  compressionEfficiency: number;
  errorPenalty: number;
  overall: number;
  passed: boolean;
}
