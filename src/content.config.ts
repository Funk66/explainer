import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import path from 'node:path';

// scripts/build.ts sets EXPLAINER_CONTENT_DIR (the folder that contains explainer folders) and
// EXPLAINER_SLUG, so exactly one explainer is compiled and a broken draft elsewhere can't break it.
// Without them (`npm run dev`) every explainer in the data directory is served.
const contentDir = process.env.EXPLAINER_CONTENT_DIR ?? path.resolve(process.env.EXPLAINER_DATA_DIR ?? './data', 'explainers');
const only = process.env.EXPLAINER_SLUG;

const explainers = defineCollection({
  loader: glob({
    base: contentDir,
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
