import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { BridgeError, id, workspaceSchema } from '../protocol/index.js';
import type { WorkspaceIdentity } from '../protocol/index.js';

export const credentialSchema = z
  .object({ device_id: id, token: z.string().min(32).max(512) })
  .strict();
export type DeviceCredential = z.infer<typeof credentialSchema>;

/** Deliberately separate from project configuration and the official Claude login. */
export function stateHome(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME;
  if (base && !isAbsolute(base))
    throw new BridgeError('INVALID_CONFIG', 'XDG_STATE_HOME must be an absolute path.');
  return join(base || join(homedir(), '.local', 'state'), 'claude-tether');
}

export function ensurePrivateDirectory(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return validatePrivateDirectory(absolute);
}

/** Validate existing state without creating directories or changing permissions. */
export function validatePrivateDirectory(path: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new BridgeError(
      'STATE_PERMISSIONS',
      'State directory must be a private regular directory (chmod 700).',
    );
  }
  return realpathSync(absolute);
}

export function readCredential(path: string): DeviceCredential {
  return credentialSchema.parse(readPrivateJson(path, 4096, 'CREDENTIAL_PERMISSIONS'));
}

function readPrivateJson(path: string, maxBytes: number, errorCode: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
      throw new BridgeError(
        errorCode,
        'Use a private regular state or credential file (chmod 600) within its size limit.',
      );
    }
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

const identitySchema = z
  .object({
    root: z.string(),
    directory_identity: z.string(),
    policy: z.enum(['ask', 'read-only']),
    binding: workspaceSchema,
  })
  .strict();

export function readWorkspaceIdentity(
  path: string,
  expected: {
    root: string;
    directory_identity: string;
    policy: 'ask' | 'read-only';
    device_id: string;
  },
): WorkspaceIdentity | undefined {
  let identity: z.infer<typeof identitySchema>;
  try {
    identity = identitySchema.parse(readPrivateJson(path, 8192, 'STATE_PERMISSIONS'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (
    identity.root !== expected.root ||
    identity.directory_identity !== expected.directory_identity ||
    identity.binding.device_id !== expected.device_id
  )
    throw new BridgeError(
      'WORKSPACE_MISMATCH',
      'Workspace or device changed. Use the original project and device state.',
    );
  if (identity.policy !== expected.policy)
    throw new BridgeError(
      'POLICY_CHANGED',
      'Policy changed. Use the original policy or a new state directory.',
    );
  return identity.binding;
}

export function clientState(
  root: string,
  device: string,
  url: string,
  policy: string,
  home = stateHome(),
): string {
  const key = createHash('sha256')
    .update(JSON.stringify([root, device, url, policy]))
    .digest('hex')
    .slice(0, 32);
  return join(home, 'workspaces', key);
}

export function assertOutsideWorkspace(root: string, state: string): void {
  const child = relative(realpathSync(root), realpathSync(state));
  if (child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))) {
    throw new BridgeError('STATE_IN_WORKSPACE', 'Store client state outside the workspace.');
  }
}
