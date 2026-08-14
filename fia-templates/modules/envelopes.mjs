import { z } from 'zod';

export const EnvelopeBaseSchema = z.object({
  status: z.enum(['success', 'fail']),
  summary: z.string().default(''),
  artifacts: z.array(z.string()).default([]),
  notes_for_next_agent: z.string().default(''),
});

export const GenericOutputSchema = EnvelopeBaseSchema;
export const PlanOutputSchema = EnvelopeBaseSchema.extend({ commit_message: z.string().default('') });
export const BuildOutputSchema = EnvelopeBaseSchema.extend({
  changed_files: z.array(z.string()).default([]),
  commit_message: z.string().default(''),
});
export const ScoutFindingSchema = z.object({ file: z.string(), note: z.string().default('') });
export const ScoutOutputSchema = EnvelopeBaseSchema.extend({
  findings: z.array(ScoutFindingSchema).default([]),
});
export const ReviewFindingSchema = z.object({
  requirement: z.string(),
  met: z.boolean(),
  evidence: z.string().default(''),
});
export const ReviewOutputSchema = EnvelopeBaseSchema.extend({
  approved: z.boolean().default(false),
  findings: z.array(ReviewFindingSchema).default([]),
  blocking: z.array(z.string()).default([]),
});
export const DocumentOutputSchema = EnvelopeBaseSchema.extend({
  document_path: z.string().default(''),
  documented_files: z.array(z.string()).default([]),
  commit_message: z.string().default(''),
});
export const VerifyOutputSchema = EnvelopeBaseSchema.extend({
  passed: z.boolean().default(false),
  failures: z.array(z.string()).default([]),
});

export const OUTPUT_TYPES = {
  GenericOutput: GenericOutputSchema,
  PlanOutput: PlanOutputSchema,
  BuildOutput: BuildOutputSchema,
  ScoutOutput: ScoutOutputSchema,
  ReviewOutput: ReviewOutputSchema,
  DocumentOutput: DocumentOutputSchema,
  VerifyOutput: VerifyOutputSchema,
};

export function getOutputSchema(name) {
  const schema = OUTPUT_TYPES[name];
  if (!schema) throw new Error(`unknown output type ${name}`);
  return schema;
}

export function extractJson(text) {
  let candidate = text;
  if (text.includes('```')) {
    for (const block of text.split('```').slice(1).filter((_, i) => i % 2 === 0)) {
      const cleaned = block.replace(/^json\s*/i, '').trim();
      if (cleaned.startsWith('{')) {
        candidate = cleaned;
        break;
      }
    }
  }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found in the response');
  return JSON.parse(candidate.slice(start, end + 1));
}
