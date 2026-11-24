import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// When EXPLAINER_SLUG is set (the normal build path) only that explainer is compiled,
// so a broken draft elsewhere can never break the build of the one you asked for.
const only = process.env.EXPLAINER_SLUG;

const explainers = defineCollection({
  loader: glob({
    base: './explainers',
    pattern: only ? `${only}/index.mdx` : '*/index.mdx',
    generateId: ({ entry }) => entry.split('/')[0],
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()).default([]),
    date: z.coerce.date().optional(),
    level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
    model: z.string().optional(),
  }),
});

export const collections = { explainers };
