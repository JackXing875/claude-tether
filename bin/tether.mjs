#!/usr/bin/env node
// This guard intentionally uses syntax supported before the minimum Node version.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 14) {
  console.error('Claude Tether requires Node.js >=24.14.0 <25. See .nvmrc.');
  process.exitCode = 1;
} else {
  try {
    const { main } = await import('../dist/apps/cli/index.js');
    await main(process.argv.slice(2));
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(
        'Tether build is missing. From a source checkout, run npm ci && npm run build.',
      );
    } else {
      console.error('Tether could not start. Run tether doctor to inspect the installation.');
    }
    process.exitCode = 1;
  }
}
