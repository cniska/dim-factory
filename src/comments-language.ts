import { javascriptComments } from "./comments-javascript";

export type CommentSpan = { start: number; end: number };

export type CommentLanguage = {
  reads(path: string): boolean;
  comments(path: string, text: string, options: { recover: boolean }): CommentSpan[] | null;
  extent(path: string, text: string, comment: CommentSpan): CommentSpan;
};

const COMMENT_LANGUAGES: readonly CommentLanguage[] = [javascriptComments];

export function languageFor(path: string): CommentLanguage | undefined {
  return COMMENT_LANGUAGES.find((language) => language.reads(path));
}
