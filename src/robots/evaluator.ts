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

/** パターン中の regex 特殊文字をエスケープ ('*' はワイルドカードとして残す) */
function escapeForRegex(ch: string): string {
  return /[.+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function patternToRegex(pattern: string): RegExp {
  const hasEnd = pattern.endsWith('$');
  const body = hasEnd ? pattern.slice(0, -1) : pattern;
  let source = '';
  for (const ch of body) {
    source += ch === '*' ? '.*' : escapeForRegex(ch);
  }
  return new RegExp(`^${source}${hasEnd ? '$' : ''}`);
}

function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === '') return true; // 空パターンは常に一致 (allow: 空 相当。到達しても実害なし)
  return patternToRegex(pattern).test(path);
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
