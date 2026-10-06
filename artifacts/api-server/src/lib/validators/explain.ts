import { z } from 'zod';

// Size caps only — the score payloads are built client-side and go straight into a Haiku
// prompt, so the risk is token inflation, not shape. Field types stay loose (passthrough)
// so the three UI callers' existing payloads (some with null fields) keep validating.
const label = z.string().max(120);
const labelList = z.array(label).max(25);
const boundedRecord = <T extends z.ZodTypeAny>(value: T) =>
  z.record(z.string().max(120), value).refine(r => Object.keys(r).length <= 100, 'too many metrics');

const fundamentalData = z.object({
  topMetrics:     labelList,
  weakMetrics:    labelList,
  suspectMetrics: labelList.nullish(),
  reason:         z.string().max(2000).nullish(),
  metricValues:   boundedRecord(z.unknown()).nullish(),
  metricDetails:  boundedRecord(z.unknown()).nullish(),
}).passthrough();

const technicalData = z.object({
  reason: z.string().max(2000).nullish(),
}).passthrough();

export const explainScoreSchema = z.object({
  ticker:          z.string().min(1).max(12),
  scoreType:       z.enum(['fundamental', 'technical']),
  fundamentalData: fundamentalData.optional(),
  technicalData:   technicalData.optional(),
});
