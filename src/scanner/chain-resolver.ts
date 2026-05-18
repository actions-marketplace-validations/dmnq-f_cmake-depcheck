import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  findClosingParen,
  lineNumberAt,
  stripComments,
  tokenize,
  trailingCommentOnLineContaining,
} from '../cmake-utils.js';
import { SHA_PATTERN } from '../constants.js';
import { FetchContentDependency } from '../parser/types.js';

export interface VariableInfo {
  value: string;
  /** Absolute path to the file containing the set() call */
  file: string;
  /** Line number of the set() call */
  line: number;
  /**
   * Trailing comment body on the `set()` line, cleaned. Cosmetic only —
   * propagated to consuming deps so PR generation can update the comment
   * alongside a SHA rewrite.
   */
  hint?: string;
  /**
   * Trailing-comment fragment of the `set()` line as it appears in source,
   * starting from the whitespace before `#` through end of line. Preserved
   * verbatim for `computeEdit` to reproduce whitespace exactly.
   */
  hintRaw?: string;
}

export interface ChainResult {
  files: string[];
  warnings: string[];
  vars: Map<string, VariableInfo>;
}

function isModuleName(arg: string): boolean {
  return !arg.includes('/') && !arg.includes('\\') && !arg.endsWith('.cmake');
}

/** Look up a variable's string value from either map shape. */
function varValue(
  vars: Map<string, string> | Map<string, VariableInfo>,
  name: string,
): string | undefined {
  const entry = vars.get(name) as string | VariableInfo | undefined;
  if (entry === undefined) return undefined;
  return typeof entry === 'string' ? entry : entry.value;
}

/**
 * Resolve ${VAR} references in a string using the variable table.
 * Returns null if any variables remain unresolved.
 */
export function resolveVariables(
  input: string,
  vars: Map<string, string> | Map<string, VariableInfo>,
  depth = 0,
): string | null {
  if (depth > 10) return null;
  if (!input.includes('${')) return input;

  const result = input.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    const value = varValue(vars, varName);
    if (value === undefined) return _match;
    return value;
  });

  if (result.includes('${') && result !== input) {
    return resolveVariables(result, vars, depth + 1);
  }

  return result.includes('${') ? null : result;
}

/**
 * Extract set() calls from file content and populate the variable table.
 * Skips CACHE variables, PARENT_SCOPE, ENV{}, and multi-value set() calls.
 */
function extractSetCalls(content: string, vars: Map<string, VariableInfo>, filePath: string): void {
  const cleaned = stripComments(content);
  const pattern = /\bset\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(cleaned)) !== null) {
    const openIdx = cleaned.indexOf('(', match.index);
    if (openIdx === -1) continue;

    const closeIdx = findClosingParen(cleaned, openIdx);
    if (closeIdx === -1) continue;

    const body = cleaned.substring(openIdx + 1, closeIdx);
    const tokens = tokenize(body);

    if (tokens.length < 2) continue;

    // Skip CACHE, PARENT_SCOPE, ENV{}
    const upperTokens = tokens.map((t) => t.toUpperCase());
    if (upperTokens.includes('CACHE')) continue;
    if (upperTokens.includes('PARENT_SCOPE')) continue;
    if (tokens[0].startsWith('ENV{')) continue;

    const varName = tokens[0];
    // Skip multi-value set() — only track single-value assignments
    // The value is tokens[1]; anything beyond that is a second value (not a keyword)
    if (tokens.length > 2) continue;

    let value = tokens[1];

    // Resolve any variable references in the value
    const resolved = resolveVariables(value, vars);
    if (resolved !== null) {
      value = resolved;
    }

    // match.index / closeIdx are positions in `cleaned`, which has different
    // byte offsets within commented lines than `content`. lineNumberAt must
    // be called against the same string the index came from.
    const line = lineNumberAt(cleaned, match.index);
    const setEndLine = lineNumberAt(cleaned, closeIdx);
    const trailing = trailingCommentOnLineContaining(content, tokens[1], line, setEndLine);
    const info: VariableInfo = { value, file: filePath, line };
    if (trailing) {
      info.hint = trailing.comment;
      info.hintRaw = trailing.raw;
    }
    vars.set(varName, info);
  }
}

/**
 * Detect project() calls and update PROJECT_SOURCE_DIR.
 */
function detectProjectCalls(
  content: string,
  currentSourceDir: string,
  filePath: string,
  vars: Map<string, VariableInfo>,
): void {
  const cleaned = stripComments(content);
  const projectIdx = cleaned.search(/\bproject\s*\(/i);
  if (projectIdx !== -1) {
    vars.set('PROJECT_SOURCE_DIR', {
      value: currentSourceDir,
      file: filePath,
      line: lineNumberAt(cleaned, projectIdx),
    });
  }
}

/**
 * Set built-in variables for the file being processed.
 *
 * For CMakeLists.txt entered via add_subdirectory():
 *   CMAKE_CURRENT_SOURCE_DIR = the file's directory
 *   CMAKE_CURRENT_LIST_DIR = the file's directory
 *
 * For .cmake files entered via include():
 *   CMAKE_CURRENT_SOURCE_DIR = unchanged (the including CMakeLists.txt's directory)
 *   CMAKE_CURRENT_LIST_DIR = the .cmake file's directory
 */
function setBuiltins(
  vars: Map<string, VariableInfo>,
  filePath: string,
  currentSourceDir: string,
): void {
  const info = (value: string): VariableInfo => ({ value, file: filePath, line: 0 });
  vars.set('CMAKE_CURRENT_SOURCE_DIR', info(currentSourceDir));
  vars.set('CMAKE_CURRENT_LIST_DIR', info(path.dirname(filePath)));
  vars.set('CMAKE_CURRENT_LIST_FILE', info(filePath));
}

/**
 * Resolve the chain of include() and add_subdirectory() calls starting from an entry file.
 * Returns all discovered file paths and any warnings for unresolvable references.
 */
export function resolveChain(entryFile: string): ChainResult {
  const visited = new Set<string>();
  const files: string[] = [];
  const warnings: string[] = [];
  const vars = new Map<string, VariableInfo>();

  const entryDir = path.dirname(path.resolve(entryFile));
  const entryPath = path.resolve(entryFile);
  const builtin = (value: string): VariableInfo => ({ value, file: entryPath, line: 0 });
  vars.set('CMAKE_SOURCE_DIR', builtin(entryDir));
  vars.set('PROJECT_SOURCE_DIR', builtin(entryDir));

  function visit(filePath: string, currentSourceDir: string): void {
    const resolved = path.resolve(filePath);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    files.push(resolved);

    const content = fs.readFileSync(resolved, 'utf-8');
    const cleaned = stripComments(content);
    const dir = path.dirname(resolved);

    // Set built-in variables for this file
    setBuiltins(vars, resolved, currentSourceDir);

    // Detect project() calls
    detectProjectCalls(content, currentSourceDir, resolved, vars);

    // Extract set() calls before processing directives
    extractSetCalls(content, vars, resolved);

    const directivePattern = /\b(include|add_subdirectory)\s*\(/gi;
    let match: RegExpExecArray | null;
    while ((match = directivePattern.exec(cleaned)) !== null) {
      const openIdx = cleaned.indexOf('(', match.index);
      if (openIdx === -1) continue;

      const closeIdx = findClosingParen(cleaned, openIdx);
      if (closeIdx === -1) continue;

      const body = cleaned.substring(openIdx + 1, closeIdx);
      const tokens = tokenize(body);
      if (tokens.length === 0) continue;

      const kind = match[1].toLowerCase();
      let arg = tokens[0];
      const line = lineNumberAt(cleaned, match.index);

      // Try to resolve variables in the argument
      if (arg.includes('${') || arg.includes('$<')) {
        if (arg.includes('$<')) {
          warnings.push(`Warning: skipping unresolvable path '${arg}' in ${resolved}:${line}`);
          continue;
        }
        const resolvedArg = resolveVariables(arg, vars);
        if (resolvedArg === null) {
          warnings.push(`Warning: skipping unresolvable path '${arg}' in ${resolved}:${line}`);
          continue;
        }
        arg = resolvedArg;
      }

      if (kind === 'include') {
        if (isModuleName(arg)) {
          continue;
        }

        let target = path.resolve(dir, arg);
        if (!target.endsWith('.cmake')) {
          target += '.cmake';
        }

        if (!fs.existsSync(target)) {
          warnings.push(`Warning: file not found '${target}' referenced in ${resolved}:${line}`);
          continue;
        }

        // For include(), CMAKE_CURRENT_SOURCE_DIR stays at the current value
        visit(target, currentSourceDir);
        setBuiltins(vars, resolved, currentSourceDir);
      } else {
        // add_subdirectory — CMAKE_CURRENT_SOURCE_DIR becomes the subdirectory
        const subdir = path.resolve(dir, arg);
        const target = path.join(subdir, 'CMakeLists.txt');

        if (!fs.existsSync(target)) {
          warnings.push(`Warning: file not found '${target}' referenced in ${resolved}:${line}`);
          continue;
        }

        visit(target, subdir);
        setBuiltins(vars, resolved, currentSourceDir);
      }
    }
  }

  visit(path.resolve(entryFile), entryDir);
  return { files, warnings, vars };
}

/**
 * Resolve ${VAR} references in dependency fields using a variable table.
 * Mutates deps in place. Fields that can't be resolved are left as-is.
 */
export function resolveDependencyVariables(
  deps: FetchContentDependency[],
  vars: Map<string, VariableInfo>,
): void {
  for (const dep of deps) {
    if (dep.gitRepository?.includes('${')) {
      dep.gitRepository = resolveVariables(dep.gitRepository, vars) ?? dep.gitRepository;
    }
    if (dep.gitTag?.includes('${')) {
      const varName = dep.gitTag.match(/\$\{(\w+)\}/)?.[1];
      dep.gitTagRaw = dep.gitTag;
      dep.gitTag = resolveVariables(dep.gitTag, vars) ?? dep.gitTag;
      dep.gitTagIsSha = SHA_PATTERN.test(dep.gitTag);
      if (varName && dep.gitTagComment === undefined) {
        const info = vars.get(varName);
        if (info?.hint !== undefined) {
          dep.gitTagComment = info.hint;
          dep.gitTagCommentRaw = info.hintRaw;
        }
      }
    }
    if (dep.url?.includes('${')) {
      dep.urlRaw = dep.url;
      dep.url = resolveVariables(dep.url, vars) ?? dep.url;
    }
    if (dep.urlHash?.includes('${')) {
      dep.urlHash = resolveVariables(dep.urlHash, vars) ?? dep.urlHash;
    }
    if (dep.sourceSubdir?.includes('${')) {
      dep.sourceSubdir = resolveVariables(dep.sourceSubdir, vars) ?? dep.sourceSubdir;
    }
  }
}
