import { spawnSync } from 'node:child_process';
import { credentialConflicts, CLAUDE_VERSION } from '../../packages/runtime-adapter/claude.js';

const version = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000 });
const auth = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
let loggedIn = false, authMethod = 'unknown';
try {
  const value = JSON.parse(auth.stdout) as { loggedIn?: unknown; authMethod?: unknown };
  loggedIn = value.loggedIn === true;
  if (['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(String(value.authMethod))) authMethod = String(value.authMethod);
} catch { /* Only report allowlisted summaries, never raw output. */ }
const actualVersion = /^\d+\.\d+\.\d+/.exec(version.stdout ?? '')?.[0] ?? null;
console.log(JSON.stringify({
  node: process.version, platform: process.platform, claude_version: actualVersion,
  expected_claude_version: CLAUDE_VERSION, version_matches: actualVersion === CLAUDE_VERSION,
  logged_in: loggedIn, auth_method: authMethod,
  credential_conflict_names: credentialConflicts(process.env),
  subscription_verified: false,
  note: 'Read-only local inspection. Does not issue a model request or prove VPS/subscription compatibility.',
}, null, 2));
