import { z } from 'zod';

export const feedbackSchema = z.object({
  message: z.string().min(1, 'Feedback message is required').max(2000, 'Feedback must be under 2000 characters'),
  page:    z.string().max(200).optional(),
});
