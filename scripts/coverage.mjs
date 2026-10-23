import { mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

mkdirSync('coverage', { recursive: true });
const tests = readdirSync('dist/tests')
  .filter((file) => file.endsWith('.test.js'))
  .map((file) => 'dist/tests/' + file);
const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=dist/packages/**',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    '--test-reporter-destination=coverage/lcov.info',
    ...tests,
  ],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
