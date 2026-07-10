/**
 * RFC 9309 §2.2 のルール評価 (グループ選択・最長一致・ワイルドカード)。
 */
import type { RobotsVerdict } from '../shared/contracts';
import type { RobotsGroup, RobotsRule, RobotsRules } from './types';
import { normalizePercentEncoding } from './parser';

export interface EvaluateRobotsResult {
  verdict: RobotsVerdict;
  /** 'utsuroibot' | '*' | 'none' (どのグループも該当せずデフォルト許可) */
  userAgentGroup: string;
  /** 例: 'disallow: /private'。マッチした明示ルールが無ければ null */
  matchedRule: string | null;
}

/**
 * '*' ワイルドカードのみを解釈する glob の完全一致判定 (two-pointer, 線形時間)。
 * 正規表現ベース (旧実装) は細工された robots.txt パターン (例: 複数の '*' が連続/重複する
 * パターンと、それにマッチしにくい入力の組み合わせ) によって指数関数的なバックトラッキングを
 * 誘発されうる (ReDoS)。本実装はバックトラッキング正規表現エンジンを使わず、'*' の直近出現位置
 * だけを記憶して再試行する古典的アルゴリズム (LeetCode 44 と同種) のため、最悪でも
 * O(pattern.length * text.length) の多項式時間で確定し、入力に対して指数的に悪化しない。
 */
function globFullMatch(pattern: string, text: string): boolean {
  let pIdx = 0;
  let tIdx = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (tIdx < text.length) {
    if (pIdx < pattern.length && (pattern[pIdx] === '*' || pattern[pIdx] === text[tIdx])) {
      if (pattern[pIdx] === '*') {
        starIdx = pIdx;
        matchIdx = tIdx;
        pIdx += 1;
      } else {
        pIdx += 1;
        tIdx += 1;
      }
    } else if (starIdx !== -1) {
      // 直近の '*' がもう1文字多く消費するとみなして再試行する。
      pIdx = starIdx + 1;
      matchIdx += 1;
      tIdx = matchIdx;
    } else {
      return false;
    }
  }

  // 残りが '*' だけなら (0文字消費として) 一致とみなす。
  while (pIdx < pattern.length && pattern[pIdx] === '*') pIdx += 1;
  return pIdx === pattern.length;
}

/**
 * robots.txt の pattern 意味論: '*' は任意長 (0文字含む) の任意文字列に一致し、末尾 '$' は
 * 「path の末尾までで完全一致」を意味する。'$' が無ければ prefix 一致 (path の残りは任意) を
 * 意味するため、内部的には pattern の末尾に暗黙の '*' を1つ足した上で globFullMatch (完全一致)
 * を行うことで prefix 一致を表現する。
 */
function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === '') return true; // 空パターンは常に一致 (allow: 空 相当。到達しても実害なし)
  const hasEnd = pattern.endsWith('$');
  const body = hasEnd ? pattern.slice(0, -1) : `${pattern}*`;
  return globFullMatch(body, path);
}

/**
 * 宣言された user-agent トークンが、こちらの uaToken にマッチするか判定する。
 * RFC 9309: クローラは自身のプロダクトトークンと robots.txt の user-agent 値を
 * 大文字小文字を無視した部分一致で比較し、最も具体的 (長い) ものを採用する。
 */
function agentMatches(declared: string, uaToken: string): boolean {
  if (declared === '' || declared === '*') return false;
  return uaToken.toLowerCase().includes(declared.toLowerCase());
}

function bestRuleForPath(rules: RobotsRule[], path: string): RobotsRule | null {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!matchesPattern(rule.pattern, path)) continue;
    if (!best) {
      best = rule;
      continue;
    }
    if (rule.pattern.length > best.pattern.length) {
      best = rule;
    } else if (rule.pattern.length === best.pattern.length) {
      // 同長なら allow を優先 (RFC 9309 §2.2.2)
      if (rule.directive === 'allow' && best.directive === 'disallow') best = rule;
    }
  }
  return best;
}

function pathAndQueryOf(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === '' ? '/' : parsed.pathname;
  return normalizePercentEncoding(path + parsed.search);
}

function selectApplicableGroups(rules: RobotsRules, uaToken: string): { groups: RobotsGroup[]; label: string } {
  let bestLen = 0;
  let matched: RobotsGroup[] = [];
  for (const group of rules.groups) {
    for (const ua of group.userAgents) {
      if (!agentMatches(ua, uaToken)) continue;
      if (ua.length > bestLen) {
        bestLen = ua.length;
        matched = [group];
      } else if (ua.length === bestLen) {
        if (!matched.includes(group)) matched.push(group);
      }
    }
  }
  if (matched.length > 0) {
    return { groups: matched, label: 'utsuroibot' };
  }

  const wildcardGroups = rules.groups.filter((g) => g.userAgents.includes('*'));
  if (wildcardGroups.length > 0) {
    return { groups: wildcardGroups, label: '*' };
  }

  return { groups: [], label: 'none' };
}

export function evaluateRobots(rules: RobotsRules, url: string, uaToken: string): EvaluateRobotsResult {
  const { groups, label } = selectApplicableGroups(rules, uaToken);

  if (groups.length === 0) {
    return { verdict: 'allowed', userAgentGroup: label, matchedRule: null };
  }

  const path = pathAndQueryOf(url);
  const allRules = groups.flatMap((g) => g.rules);
  const best = bestRuleForPath(allRules, path);

  if (!best) {
    return { verdict: 'allowed', userAgentGroup: label, matchedRule: null };
  }

  return {
    verdict: best.directive === 'allow' ? 'allowed' : 'disallowed',
    userAgentGroup: label,
    matchedRule: `${best.directive}: ${best.pattern}`,
  };
}
