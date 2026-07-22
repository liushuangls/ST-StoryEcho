export type StorySkeletonQualityIssueKind =
  | 'relationship-absence'
  | 'relationship-stage'
  | 'state-snapshot';

export interface StorySkeletonQualityIssue {
  kind: StorySkeletonQualityIssueKind;
  excerpt: string;
}

const ABSENCE_MARKER_PATTERN = /(?:没有|并未|未曾|尚未|未达|不主动|并非|不是|仅是|只是|仍是)/u;
const DIRECT_RELATIONSHIP_TERM_PATTERN = /(?:恋爱|道侣|告白|亲密|伴侣|情感(?:确认|承诺|回应))/u;
const SOCIAL_CONTEXT_PATTERN = /(?:两人|双方|二人|师徒|师姐弟|同门|熟人|伙伴|同行者|亲近|信任|依赖|边界)/u;
const GENERAL_RELATIONSHIP_TERM_PATTERN = /(?:关系|承诺|回应|身份)/u;
const RELATIONSHIP_STAGE_PATTERN = /(?:进入|处于|形成|发展为|转为|仍是|只是|维持|保持)[^。！？\n]{0,36}(?:信任期|关系阶段|熟人关系|伙伴关系|同行者关系|师徒关系|师姐弟关系|合作关系)/u;
const SPEECH_VERB_PATTERN = /(?:说|表示|回答|拒绝|声明|告知|强调|要求|承认)/u;
const QUOTED_RELATIONSHIP_PATTERN = /[“"][^”"\n]*(?:恋爱|道侣|告白|亲密|伴侣|关系|承诺|身份)[^”"\n]*[”"]/u;
const SNAPSHOT_HEADING_PATTERN = /^#{1,6}\s*.*(?:当前|现状|状态|人物关系(?:概览|总览)|角色状态)/u;
const SNAPSHOT_OPENING_PATTERN = /^(?:截至|当前|现状)/u;
const SNAPSHOT_CONTENT_PATTERN = /(?:境界|修为|灵力|神识|伤势|装备|物品|位置|好感|关系|仍处于|现为|已是)/u;

function compactExcerpt(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 360);
}

function sentenceUnits(paragraph: string): string[] {
  return paragraph.match(/[^。！？\n]+[。！？]?/gu) ?? [];
}

function isExplicitRelationshipSpeech(text: string): boolean {
  return SPEECH_VERB_PATTERN.test(text) && QUOTED_RELATIONSHIP_PATTERN.test(text);
}

function hasInterpersonalRelationshipContext(text: string): boolean {
  return DIRECT_RELATIONSHIP_TERM_PATTERN.test(text) || (
    SOCIAL_CONTEXT_PATTERN.test(text) && GENERAL_RELATIONSHIP_TERM_PATTERN.test(text)
  );
}

export function storySkeletonQualityIssues(
  text: string,
  maxIssues = 12,
): StorySkeletonQualityIssue[] {
  const limit = Math.max(1, Math.floor(maxIssues));
  const issues: StorySkeletonQualityIssue[] = [];
  const seen = new Set<string>();
  const paragraphs = String(text ?? '')
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const add = (kind: StorySkeletonQualityIssueKind, source: string): void => {
    const excerpt = compactExcerpt(source);
    const key = `${kind}:${excerpt}`;
    if (!excerpt || seen.has(key) || issues.length >= limit) {
      return;
    }
    seen.add(key);
    issues.push({ kind, excerpt });
  };

  for (const paragraph of paragraphs) {
    if (SNAPSHOT_HEADING_PATTERN.test(paragraph)) {
      add('state-snapshot', paragraph);
    } else if (
      SNAPSHOT_OPENING_PATTERN.test(paragraph) &&
      SNAPSHOT_CONTENT_PATTERN.test(paragraph)
    ) {
      add('state-snapshot', paragraph);
    }

    if (paragraph.startsWith('#')) {
      continue;
    }
    for (const sentence of sentenceUnits(paragraph)) {
      if (isExplicitRelationshipSpeech(sentence)) {
        continue;
      }
      if (RELATIONSHIP_STAGE_PATTERN.test(sentence)) {
        add('relationship-stage', sentence);
        continue;
      }
      if (
        ABSENCE_MARKER_PATTERN.test(sentence) &&
        hasInterpersonalRelationshipContext(sentence)
      ) {
        add('relationship-absence', sentence);
      }
    }
  }
  return issues;
}
