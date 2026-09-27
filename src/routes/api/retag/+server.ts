import { error, json } from '@sveltejs/kit';
import { createRetagJob } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

/**
 * { folders: string[], mode?: 'auto' | 'songs' }. 'auto' re-tags a folder as one album unless it
 * looks like a playlist; 'songs' always re-tags each song on its own.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as {
    folders?: unknown;
    mode?: unknown;
  } | null;
  const mode = body?.mode === 'songs' ? 'songs' : 'auto';
  const folders = Array.isArray(body?.folders)
    ? [...new Set(body.folders.filter((f): f is string => typeof f === 'string' && f !== ''))]
    : [];
  if (!folders.length) error(400, 'Pick at least one folder.');

  const started: string[] = [];
  const failed: { folder: string; message: string }[] = [];
  for (const folder of folders) {
    try {
      started.push((await createRetagJob(folder, mode)).id);
    } catch (err) {
      failed.push({ folder, message: (err as Error).message });
    }
  }
  return json({ started, failed }, { status: started.length ? 201 : 400 });
};
