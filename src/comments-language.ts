export type CommentSpan = { start: number; end: number };

export type CommentLanguage = {
  readonly name: string;
  reads(path: string): boolean;
  comments(path: string, text: string, options: { recover: boolean }): CommentSpan[] | null;
  extent(path: string, text: string, comment: CommentSpan): CommentSpan;
};

export function languageFor(
  path: string,
  languages: readonly CommentLanguage[],
): CommentLanguage | undefined {
  return languages.find((language) => language.reads(path));
}
