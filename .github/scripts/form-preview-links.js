// Builds a Markdown comment with playground preview links for every form changed in a pull request.
//
// Usage: node .github/scripts/form-preview-links.js <base-sha> <head-sha> <output-file>
//
// File contents are read from git objects (never executed), so this is safe to run
// against untrusted pull request commits.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import lz from 'lz-string';

const FORMS_DIR = 'lib/forms';
const PLAYGROUND_URL = 'https://playground.opendatacapture.org';
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.jsx', '.ts', '.tsx']);

// GitHub rejects comments longer than 65536 characters
const MAX_COMMENT_LENGTH = 65000;

const COMMENT_MARKER = '<!-- form-preview-links -->';

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Runs a git command with NUL-separated output, so non-ASCII paths are not quoted
 * @param {string[]} args
 */
function gitPaths(args) {
  const [command, ...rest] = args;
  return git([command, '-z', ...rest])
    .split('\0')
    .filter(Boolean);
}

/** @param {{ content: string, name: string }[]} files */
function encodeFiles(files) {
  return lz.compressToEncodedURIComponent(JSON.stringify(files));
}

/** @param {{ files: { content: string, name: string }[], label: string }} instrument */
function encodeShareURL({ files, label }) {
  const url = new URL(PLAYGROUND_URL);
  url.searchParams.append('files', encodeFiles(files));
  url.searchParams.append('label', lz.compressToEncodedURIComponent(label));
  return url;
}

const [baseSha, headSha, outputFile] = process.argv.slice(2);
if (!baseSha || !headSha || !outputFile) {
  console.error('Usage: node form-preview-links.js <base-sha> <head-sha> <output-file>');
  process.exit(1);
}

// Three-dot diff: only changes introduced by the PR since it diverged from the base branch
const changedPaths = gitPaths(['diff', '--name-only', '--diff-filter=d', `${baseSha}...${headSha}`, '--', FORMS_DIR]);

/** Names of form directories (e.g. "GAD_7") with at least one added or modified file */
const changedForms = [...new Set(changedPaths.map((filepath) => filepath.split('/')[2]).filter(Boolean))].sort();

const lines = [COMMENT_MARKER, '### Form previews', ''];

if (changedForms.length === 0) {
  lines.push('This pull request does not add or modify any forms.');
} else {
  lines.push('Open the forms changed in this pull request in the Open Data Capture playground:', '');
  const skipped = [];
  for (const formName of changedForms) {
    const formDir = `${FORMS_DIR}/${formName}/`;
    const files = [];
    for (const filepath of gitPaths(['ls-tree', '-r', '--name-only', headSha, '--', formDir])) {
      if (TEXT_EXTENSIONS.has(path.extname(filepath))) {
        files.push({ content: git(['show', `${headSha}:${filepath}`]), name: filepath.slice(formDir.length) });
      } else {
        console.warn(`Skipping non-text file: ${filepath}`);
      }
    }
    if (!files.some((file) => /^index\.(js|jsx|ts|tsx)$/.test(file.name))) {
      skipped.push(`- **${formName}**: no \`index\` entrypoint found`);
      continue;
    }
    const entry = `- **${formName}**: [Open in playground](${encodeShareURL({ files, label: formName })})`;
    if ([...lines, entry].join('\n').length > MAX_COMMENT_LENGTH) {
      skipped.push(`- **${formName}**: link too long to include in a comment`);
      continue;
    }
    lines.push(entry);
  }
  if (skipped.length > 0) {
    lines.push('', 'No preview link could be generated for:', '', ...skipped);
  }
}

lines.push('', `<sub>Generated for ${headSha.slice(0, 7)}</sub>`);
writeFileSync(outputFile, lines.join('\n') + '\n');
console.log(lines.join('\n'));
