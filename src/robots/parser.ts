/**
 * RFC 9309 準拠の robots.txt パーサ。
 */
import type { RobotsGroup, RobotsRule, RobotsRules } from './types';

/** ASCII 'unreserved' (RFC 3986 §2.3): ALPHA / DIGIT / '-' '.' '_' '~' */
function isUnreservedByte(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2d || // -
    code === 0x2e || // .
    code === 0x5f || // _
    code === 0x7e // ~
  );
}

function isHexDigit(ch: string): boolean {
  return /^[0-9a-fA-F]$/.test(ch);
}

/**
 * robots.txt のパスパターン・対象URLパスの双方に適用するパーセントエンコーディング正規化。
 * - 既存の %XX のうち unreserved にデコードできるものはデコードする。
 * - それ以外の %XX は16進を大文字化して残す。
 * - 制御文字・空白・非ASCIIはパーセントエンコードする。
 * - それ以外の印字可能ASCII (構造上の区切り文字含む) はそのまま残す。
 */
export function normalizePercentEncoding(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (ch === '%' && i + 2 < input.length && isHexDigit(input[i + 1] as string) && isHexDigit(input[i + 2] as string)) {
      const hex = input.slice(i + 1, i + 3);
      const code = parseInt(hex, 16);
      out += isUnreservedByte(code) ? String.fromCharCode(code) : `%${hex.toUpperCase()}`;
      i += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code > 0x7e) {
      // 非ASCII: UTF-8バイト列へパーセントエンコード
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    } else if (code <= 0x20 || code === 0x7f) {
      // 制御文字・空白
      out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function stripComment(line: string): string {
  const idx = line.indexOf('#');
  return idx === -1 ? line : line.slice(0, idx);
}

interface RawDirective {
  field: string;
  value: string;
}

function parseLine(line: string): RawDirective | null {
  const withoutComment = stripComment(line).trim();
  if (withoutComment === '') return null;
  const sep = withoutComment.indexOf(':');
  if (sep === -1) return null; // フィールド形式でない行は無視
  const field = withoutComment.slice(0, sep).trim().toLowerCase();
  const value = withoutComment.slice(sep + 1).trim();
  return { field, value };
}

/** allow/disallow のパス値が有効か (RFC 9309: '/' または '*' で始まらないものは無視) */
function isValidPathValue(value: string): boolean {
  if (value === '') return true; // 空値は特別扱い (disallow: 空 = 制限なし)
  return value.startsWith('/') || value.startsWith('*');
}

export function parseRobotsTxt(text: string): RobotsRules {
  // BOM除去、改行コード統一
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let currentAgents: string[] = [];
  let currentRules: RobotsRule[] = [];
  let collectingAgents = false;

  const flushGroup = () => {
    if (currentAgents.length > 0) {
      groups.push({ userAgents: currentAgents, rules: currentRules });
    }
    currentAgents = [];
    currentRules = [];
  };

  for (const rawLine of lines) {
    const directive = parseLine(rawLine);
    if (!directive) continue;
    const { field, value } = directive;

    if (field === 'user-agent') {
      if (!collectingAgents) {
        flushGroup();
      }
      const token = value.toLowerCase();
      if (token !== '') currentAgents.push(token);
      collectingAgents = true;
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      collectingAgents = false;
      if (currentAgents.length === 0) {
        // どの user-agent グループにも属さないルールは無視 (先頭に UA 行がない robots.txt)
        continue;
      }
      if (!isValidPathValue(value)) continue;
      if (field === 'disallow' && value === '') {
        // 「Disallow: (空)」は制限なし = ルールを追加しない
        continue;
      }
      const pattern = normalizePercentEncoding(value);
      currentRules.push({ directive: field, pattern });
      continue;
    }

    if (field === 'sitemap') {
      collectingAgents = false;
      if (value !== '') sitemaps.push(value);
      continue;
    }

    // crawl-delay, host, その他未知ディレクティブは解釈せず無視 (グループ境界には影響しない)
    continue;
  }

  flushGroup();

  return { groups, sitemaps };
}
