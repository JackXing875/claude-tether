/* eslint-disable no-control-regex -- This sanitizer deliberately matches terminal control bytes. */
import { stripVTControlCharacters } from 'node:util';

/** Render remote text as text, without terminal cursor/title/control injection. */
export function terminalText(value: string): string {
  const withoutOsc = value.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '');
  return stripVTControlCharacters(withoutOsc).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    '',
  );
}
