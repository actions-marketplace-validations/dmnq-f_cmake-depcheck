import { FetchContentDependency } from './types.js';
import {
  findClosingParen,
  lineNumberAt,
  stripComments,
  tokenize,
  trailingCommentOnLineContaining,
} from '../cmake-utils.js';
import { SHA_PATTERN } from '../constants.js';

/** Keywords we extract values for */
const EXTRACT_KEYWORDS = ['GIT_REPOSITORY', 'GIT_TAG', 'URL', 'URL_HASH', 'SOURCE_SUBDIR'] as const;

function parseDeclaration(
  tokens: string[],
  file: string,
  startLine: number,
  endLine: number,
): FetchContentDependency | null {
  if (tokens.length === 0) return null;

  const name = tokens[0];
  const args = new Map<string, string>();

  // Scan for our keywords and grab the token that follows each one
  for (let i = 1; i < tokens.length; i++) {
    const upper = tokens[i].toUpperCase();
    const keyword = EXTRACT_KEYWORDS.find((k) => k === upper);
    if (keyword && i + 1 < tokens.length) {
      args.set(keyword, tokens[i + 1]);
      i++;
    }
  }

  const gitRepository = args.get('GIT_REPOSITORY');
  const gitTag = args.get('GIT_TAG');
  const url = args.get('URL');
  const urlHash = args.get('URL_HASH');
  const sourceSubdir = args.get('SOURCE_SUBDIR');

  const sourceType = gitRepository ? 'git' : 'url';

  const dep: FetchContentDependency = {
    name,
    sourceType,
    location: { file, startLine, endLine },
  };

  if (gitRepository) dep.gitRepository = gitRepository;
  if (gitTag !== undefined) {
    dep.gitTag = gitTag;
    dep.gitTagIsSha = SHA_PATTERN.test(gitTag);
  }
  if (url) dep.url = url;
  if (urlHash) dep.urlHash = urlHash;
  if (sourceSubdir) dep.sourceSubdir = sourceSubdir;

  return dep;
}

export function parseCMakeContent(content: string, filePath: string): FetchContentDependency[] {
  const deps: FetchContentDependency[] = [];
  const pattern = /fetchcontent_(declare|populate)\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const openParenIdx = content.indexOf('(', match.index);
    if (openParenIdx === -1) continue;

    const closeParenIdx = findClosingParen(content, openParenIdx);
    if (closeParenIdx === -1) continue;

    const body = content.substring(openParenIdx + 1, closeParenIdx);
    const tokens = tokenize(stripComments(body));

    const startLine = lineNumberAt(content, match.index);
    const endLine = lineNumberAt(content, closeParenIdx);

    const dep = parseDeclaration(tokens, filePath, startLine, endLine);
    if (!dep) continue;

    // Simple-form FetchContent_Populate(name) is just a trigger, not a declaration
    const isPopulate = match[1].toLowerCase() === 'populate';
    if (isPopulate && !dep.gitRepository && !dep.url) continue;

    if (dep.gitTag !== undefined) {
      const trailing = trailingCommentOnLineContaining(content, dep.gitTag, startLine, endLine);
      if (trailing) {
        dep.gitTagComment = trailing.comment;
        dep.gitTagCommentRaw = trailing.raw;
      }
    }

    deps.push(dep);
  }

  return deps;
}

export async function parseCMakeFile(filePath: string): Promise<FetchContentDependency[]> {
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(filePath, 'utf-8');
  return parseCMakeContent(content, filePath);
}
