import {
  constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { BridgeError, contentRevision, MAX_FILE_BYTES, toolSchemas } from '../protocol/index.js';
import type { ToolName } from '../protocol/index.js';
import { runCommand } from '../task-runner/index.js';

export interface PreparedTool {
  preview: string;
  execute(signal: AbortSignal): Promise<unknown>;
}
interface FileSnapshot { bytes: Buffer; text: string; revision: string; mode: number }

export class LocalTools {
  readonly root: string;
  private readonly rootIdentity: string;
  constructor(root: string, private readonly env: NodeJS.ProcessEnv = { ...process.env }) {
    this.root = realpathSync(root);
    const st = statSync(this.root);
    if (!st.isDirectory()) throw new BridgeError('WORKSPACE_MISMATCH', 'Workspace must be a directory.');
    this.rootIdentity = String(st.dev) + ':' + String(st.ino);
  }
  identity(): string { return this.rootIdentity; }
  resolvePath(path: string, allowMissingFinal = false): string {
    const rootStat = statSync(this.root);
    if (String(rootStat.dev) + ':' + String(rootStat.ino) !== this.rootIdentity) {
      throw new BridgeError('WORKSPACE_MISMATCH', 'Workspace directory was replaced; create a new binding.');
    }
    if (path.includes('\0') || isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.includes('\\')) {
      throw new BridgeError('PATH_NOT_ALLOWED', 'Only workspace-relative paths without parent traversal are supported.');
    }
    const target = resolve(this.root, path);
    const suffix = relative(this.root, target);
    if (suffix.startsWith('..' + sep) || isAbsolute(suffix)) throw new BridgeError('PATH_NOT_ALLOWED', 'Path is outside workspace.');
    const parts = suffix ? suffix.split(sep) : [];
    let current = this.root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      try {
        const st = lstatSync(current);
        // Conservative P1 policy: even in-root links need a later platform-specific contract.
        if (st.isSymbolicLink()) throw new BridgeError('PATH_NOT_ALLOWED', 'Symbolic links are not supported by P1 file tools.');
        if (index < parts.length - 1 && !st.isDirectory()) throw new BridgeError('PATH_NOT_ALLOWED', 'Parent path must be a directory.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (allowMissingFinal && index === parts.length - 1) return target;
          throw new BridgeError('FILE_NOT_FOUND', 'Local path does not exist.');
        }
        throw error;
      }
    }
    return target;
  }
  private read(path: string): FileSnapshot {
    const full = this.resolvePath(path);
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new BridgeError('PATH_NOT_ALLOWED', 'Only regular files are supported.');
      if (st.size > MAX_FILE_BYTES) throw new BridgeError('FILE_TOO_LARGE', 'File exceeds the P1 128 KiB limit.');
      const capture = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0, count = 0;
      do {
        count = readSync(fd, capture, length, capture.length - length, null);
        length += count;
      } while (count > 0 && length < capture.length);
      if (length > MAX_FILE_BYTES) throw new BridgeError('FILE_TOO_LARGE', 'File grew beyond the P1 size limit.');
      const bytes = capture.subarray(0, length);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new BridgeError('UNSUPPORTED_ENCODING', 'Only valid UTF-8 files are supported.'); }
      if (text.includes('\0')) throw new BridgeError('UNSUPPORTED_ENCODING', 'Binary files are not supported.');
      return { bytes, text, revision: contentRevision(bytes), mode: st.mode & 0o777 };
    } finally { closeSync(fd); }
  }
  private write(path: string, next: string, previous: FileSnapshot | null): unknown {
    const target = this.resolvePath(path, previous === null);
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new BridgeError('FILE_TOO_LARGE', 'Edited file exceeds 128 KiB.');
    if (next.includes('\0')) throw new BridgeError('UNSUPPORTED_ENCODING', 'NUL characters are not supported in text files.');
    const temp = join(dirname(target), '.relay-edit-' + randomUUID());
    let created = false;
    try {
      const fd = openSync(temp, 'wx', previous?.mode ?? 0o600); created = true;
      try { writeFileSync(fd, next, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      // Re-resolve and recheck after approval and immediately before commit.
      this.resolvePath(path, previous === null);
      if (previous) {
        if (this.read(path).revision !== previous.revision) throw new BridgeError('FILE_CHANGED', 'File changed after the preview; read it again.');
        renameSync(temp, target); created = false;
      } else {
        try { linkSync(temp, target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BridgeError('FILE_CHANGED', 'Creation target already exists.');
          throw error;
        }
        unlinkSync(temp); created = false;
      }
      const parent = openSync(dirname(target), constants.O_RDONLY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
      return { path, before_revision: previous?.revision ?? null, after_revision: contentRevision(Buffer.from(next)) };
    } finally { if (created) unlinkSync(temp); }
  }
  private async files(path: string, signal: AbortSignal): Promise<{ files: string[]; truncated: boolean }> {
    const target = this.resolvePath(path);
    if (!statSync(target).isDirectory()) throw new BridgeError('PATH_NOT_ALLOWED', 'Search root must be a directory.');
    const result = await runCommand({ program: 'rg', args: ['--files', '--null', '--', path], timeout_ms: 5000 },
      this.root, this.env, signal);
    if (result.cancelled) throw new BridgeError('CANCELLED', 'Search cancelled.');
    if (result.exit_code !== 0 && result.exit_code !== 1) throw new BridgeError('SEARCH_FAILED', 'Local ripgrep failed.');
    // Never treat a partially captured last pathname as a complete filename.
    const entries = result.stdout.split('\0'); entries.pop();
    return {
      files: entries.filter((entry) => {
        try { return statSync(this.resolvePath(entry)).isFile(); } catch { return false; }
      }),
      truncated: result.truncated,
    };
  }
  async prepare(tool: ToolName, raw: unknown): Promise<PreparedTool> {
    const input = toolSchemas[tool].parse(raw);
    if (tool === 'workspace_info') return { preview: '', execute: async () => ({
      display_path: this.root, platform: process.platform, execution: 'local',
      command_mode: 'exec', file_encoding: 'utf-8', file_limit_bytes: MAX_FILE_BYTES,
    }) };
    if (tool === 'read_file') {
      const data = input as z.infer<typeof toolSchemas.read_file>;
      return { preview: '', execute: async () => {
        const file = this.read(data.path);
        const lines = file.text.split('\n');
        const start = data.start_line - 1, end = Math.min(data.end_line ?? lines.length, lines.length);
        return {
          path: data.path, content: lines.slice(start, end).join('\n'), revision: file.revision,
          start_line: data.start_line, end_line: Math.max(start, end), total_lines: lines.length,
          partial: start > 0 || end < lines.length, encoding: 'utf-8',
          bom: file.text.startsWith('\uFEFF'), newline: file.text.includes('\r\n') ? 'CRLF' : 'LF',
        };
      } };
    }
    if (tool === 'list_files' || tool === 'search_text') {
      const data = input as z.infer<typeof toolSchemas.search_text>;
      return { preview: '', execute: async (signal) => {
        const listing = await this.files(data.path, signal);
        if (tool === 'list_files') return { files: listing.files.slice(0, data.limit), truncated: listing.truncated || listing.files.length > data.limit };
        const matches: { path: string; line: number; text: string }[] = [];
        let totalBytes = 0, scanned = 0, skipped = 0, truncated = listing.truncated;
        outer: for (const path of listing.files) {
          if (signal.aborted) throw new BridgeError('CANCELLED', 'Search cancelled.');
          if (++scanned > 2000) { truncated = true; break; }
          try {
            const file = this.read(path);
            totalBytes += file.bytes.length;
            if (totalBytes > 8 * 1024 * 1024) { truncated = true; break; }
            const lines = file.text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i]!.includes(data.query)) {
                if (matches.length === data.limit) { truncated = true; break outer; }
                matches.push({ path, line: i + 1, text: lines[i]!.slice(0, 512) });
                if (lines[i]!.length > 512) truncated = true;
              }
            }
          } catch { skipped++; }
        }
        return { matches, truncated, skipped_files: skipped, search: 'literal, visible files respecting ripgrep ignore rules' };
      } };
    }
    if (tool === 'edit_text') {
      const data = input as z.infer<typeof toolSchemas.edit_text>;
      const before = this.read(data.path);
      if (before.revision !== data.expected_revision) throw new BridgeError('FILE_CHANGED', 'File version differs from expected_revision.');
      const pieces = before.text.split(data.old_text);
      if (pieces.length - 1 !== data.expected_matches) throw new BridgeError('AMBIGUOUS_EDIT', 'Text match count differs from expected_matches.');
      const next = pieces.join(data.new_text);
      return {
        preview: createTwoFilesPatch(data.path, data.path, before.text, next),
        execute: async () => this.write(data.path, next, before),
      };
    }
    if (tool === 'write_file') {
      const data = input as z.infer<typeof toolSchemas.write_file>;
      let before: FileSnapshot | null = null;
      if (data.expected_revision !== null) {
        before = this.read(data.path);
        if (before.revision !== data.expected_revision) throw new BridgeError('FILE_CHANGED', 'File version differs from expected_revision.');
      } else {
        const target = this.resolvePath(data.path, true);
        try { lstatSync(target); throw new BridgeError('FILE_CHANGED', 'Creation target already exists.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return {
        preview: createTwoFilesPatch(data.path, data.path, before?.text ?? '', data.content),
        execute: async () => this.write(data.path, data.content, before),
      };
    }
    const data = input as z.infer<typeof toolSchemas.run_command>;
    const cwd = this.resolvePath(data.cwd);
    if (!statSync(cwd).isDirectory()) throw new BridgeError('PATH_NOT_ALLOWED', 'Command cwd must be a directory.');
    return {
      preview: JSON.stringify({ cwd: data.cwd, program: data.program, args: data.args, timeout_ms: data.timeout_ms }, null, 2) +
        '\nThis command runs with your local account permissions. cwd is not a sandbox.',
      execute: async (signal) => {
        if (this.resolvePath(data.cwd) !== cwd) throw new BridgeError('WORKSPACE_MISMATCH', 'Working directory changed.');
        return runCommand(data, cwd, this.env, signal);
      },
    };
  }
}
