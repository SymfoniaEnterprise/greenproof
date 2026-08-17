/** Schematy zod dla inwentarza POM (domain/harvest.ts). */
import { z } from 'zod';

export const InventoryKindSchema = z.enum(['pom', 'fixture']);

export const PomIndexEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: InventoryKindSchema,
  description: z.string().min(1),
  covers: z.array(z.string()),
  keySelectors: z.array(z.string()),
  harvestedBy: z.string().min(1).exactOptional(),
  reuseCount: z.number().int().nonnegative(),
  addedAt: z.iso.datetime({ offset: true }),
});

export const PomIndexSchema = z.object({
  version: z.literal(1),
  entries: z.array(PomIndexEntrySchema),
});

export const DuplicationFindingSchema = z.object({
  specPath: z.string().min(1),
  selector: z.string().min(1),
  pomName: z.string().min(1),
  pomPath: z.string().min(1),
});
