import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { credentialConflicts, CLAUDE_VERSION } from '../../packages/runtime-adapter/claude.js';

export async function runDoctor(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } });
  const version = spawnSync('claude', ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const auth = spawnSync('claude', ['auth', 'status', '--json'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const rg = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  let loggedIn = false,
    authMethod = 'unknown';
  try {
    const value = JSON.parse(auth.stdout) as { loggedIn?: unknown; authMethod?: unknown };
    loggedIn = value.loggedIn === true;
    if (
      ['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(
        String(value.authMethod),
      )
    )
      authMethod = String(value.authMethod);
  } catch {
    /* Only report allowlisted summaries, never raw output. */
  }
  const actualVersion = /^\d+\.\d+\.\d+/.exec(version.stdout ?? '')?.[0] ?? null;
  const report = {
    node: process.version,
    platform: process.platform,
    ripgrep_available: rg.status === 0,
    claude_version: actualVersion,
    expected_claude_version: CLAUDE_VERSION,
    version_matches: actualVersion === CLAUDE_VERSION,
    logged_in: loggedIn,
    auth_method: authMethod,
    credential_conflict_names: credentialConflicts(process.env),
    subscription_verified: false,
    note: 'Read-only local inspection. Does not issue a model request or prove VPS/subscription compatibility.',
  };
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Node: ' + report.node + ' (' + report.platform + ')');
    console.log(
      'ripgrep: ' +
        (report.ripgrep_available
          ? 'available'
          : 'missing — install ripgrep for file listing/search'),
    );
    console.log(
      'Claude: ' + (report.claude_version ?? 'not installed (optional for offline demo)'),
    );
    console.log('Auth: ' + report.auth_method + '; subscription compatibility remains unverified');
    if (report.credential_conflict_names.length)
      console.log('Conflicting environment names: ' + report.credential_conflict_names.join(', '));
    console.log(report.note);
  }
}
