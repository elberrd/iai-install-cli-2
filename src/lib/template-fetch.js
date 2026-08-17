// Downloads a PRIVATE template/harness through the community API (gated by the
// paying student's token) instead of cloning from GitHub. This is the "single
// gate" path: the student never needs access to the private repositories — the
// community server hands out the tarball only to those with an active
// subscription.

import { mkdtempSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { has, run } from './proc.js';
import { extractTarGz } from './tar-extract.js';
import { downloadTemplate } from './auth-client.js';

/**
 * Unpack a downloaded tarball into `destDir`. The system `tar` goes first
 * (fast, battle-tested, preserves symlinks where the OS allows them); when it
 * is missing OR fails, the built-in extractor takes over — the one failure
 * that matters in practice is Windows' bundled tar dying on the harness'
 * symlink entries ("Invalid argument") because creating links needs a
 * privilege students don't have, and the built-in extractor materializes
 * those links as copies instead. `deps` is a test seam ({ run, has }).
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function extractDownloadedTarball(tgz, destDir, deps = {}) {
  const exec = deps.run ?? run;
  const hasCmd = deps.has ?? has;
  await mkdir(destDir, { recursive: true });
  if (await hasCmd('tar')) {
    const r = await exec('tar', ['-xzf', tgz, '-C', destDir, '--strip-components=1']);
    if (r.ok) return { ok: true };
  }
  try {
    // Start clean: a failed system-tar run leaves a partial tree behind.
    await rm(destDir, { recursive: true, force: true });
    await mkdir(destDir, { recursive: true });
    extractTarGz(tgz, destDir, { strip: 1 });
    return { ok: true };
  } catch {
    // Both extractors refused the bytes — the download really is corrupted.
    return { ok: false, reason: 'extract_failed' };
  }
}

/**
 * Downloads the template `name` (live1 | live2 | harness) and extracts it into
 * `destDir`. The GitHub tarball ships a root directory `<owner>-<repo>-<sha>/`,
 * so we extract with `--strip-components=1` to get the content directly.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function fetchTemplateToDir(apiBase, token, name, destDir, ref) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'create-iai-tgz-'));
  const tgz = join(tmpRoot, `${name}.tar.gz`);
  try {
    const dl = await downloadTemplate(apiBase, token, name, tgz, ref);
    if (!dl.ok) return { ok: false, reason: dl.reason };
    return await extractDownloadedTarball(tgz, destDir);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Message for the student when the gated download fails. The distinction that
 * matters is between "wait and try again" and "retrying won't help":
 *
 *   no_active_enrollment → inactive subscription, it's on the student;
 *   missing_token / http_401 → the download needs the sign-in (a guest run
 *     reached a gated name, or the server does not serve this one anonymously
 *     yet) — retrying won't help, signing in will;
 *   server_misconfigured → missing env on the community server (e.g. the
 *     GitHub token that fetches the private repos). Saying "try again in a
 *     moment" here makes the student retry forever an error only the
 *     maintainer can fix;
 *   extract_failed → neither the system tar nor the built-in extractor could
 *     unpack the bytes — the download arrived corrupted; one re-download is
 *     worth trying, then support;
 *   download_timeout → the connection dropped mid-download;
 *   network_error → the server could not be reached at all (DNS, refused,
 *     offline) — check the connection and rerun;
 *   http_5xx → that one is indeed transient.
 *
 * @param {string} what - 'template' | 'harness'
 * @param {string|undefined} reason
 */
export function downloadErrorMessage(what, reason) {
  if (reason === 'no_active_enrollment') {
    return `Your subscription is no longer active — the ${what} could not be downloaded.`;
  }
  if (reason === 'missing_token' || reason === 'http_401') {
    return [
      `The ${what} download requires the community sign-in.`,
      'Authenticate with `npx impactus --login` (or run the installer again and',
      'choose "Sign in") and repeat the command.',
    ].join('\n');
  }
  if (reason === 'server_misconfigured') {
    return [
      `The community server couldn't deliver the ${what} (pending configuration on its side).`,
      "This is NOT a problem with your machine and repeating the command won't help —",
      'contact the community support and try again later.',
    ].join('\n');
  }
  if (reason === 'extract_failed') {
    return [
      `The downloaded ${what} file arrived corrupted and could not be unpacked.`,
      'Run the same command again to download it fresh.',
      'If it fails a second time, contact the community support.',
    ].join('\n');
  }
  if (reason === 'download_timeout') {
    return `The ${what} download stalled — the connection dropped mid-download. Check your internet and run the same command again.`;
  }
  if (reason === 'network_error') {
    return `The ${what} download failed — could not reach the server. Check your internet and run the same command again.`;
  }
  return `Failed to download the ${what} (${reason || 'error'}). Try again in a moment.`;
}
