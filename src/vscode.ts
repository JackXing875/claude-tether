#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { main } from './cli.js';

// VS Code supplies its bundled Claude executable first, followed by SDK arguments.
// Never interpret those arguments as Tether options or write banners to stdout:
// stdin/stdout carry the extension's bidirectional JSON protocol.
export async function vscodeMain(argv: string[]): Promise<number> {
  const [executable, ...args] = argv;
  if (!executable || !isAbsolute(executable)) {
    throw new Error('tether-vscode expects the absolute path to the extension\'s Claude executable as its first argument. Set claudeCode.claudeProcessWrapper to this launcher; see docs/VSCODE.md.');
  }
  return main(['--claude', executable, '--', ...args]);
}

if (import.meta.main) {
  vscodeMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error('[tether] ' + (error instanceof Error ? error.message : 'VS Code launcher failed'));
    process.exitCode = 1;
  });
}
