import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
rmSync(new URL('dist/', root), { recursive: true, force: true });
const build = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)),
    '-p',
    process.argv.includes('--tests') ? 'tsconfig.json' : 'tsconfig.build.json',
  ],
  { cwd: fileURLToPath(root), stdio: 'inherit' },
);
process.exitCode = build.status ?? 1;
