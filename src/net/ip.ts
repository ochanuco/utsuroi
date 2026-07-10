/**
 * IPアドレス判定ユーティリティ (SSRF検査用)。
 * 難読化表記 (10進一括 / 8進 / 16進 / 短縮ドット表記) を含めて解釈する。
 * WHATWG URL の hostname 正規化に依存しない防御的実装 (実行環境差異に対する保険)。
 */

export type IpBlockReason = 'loopback' | 'private' | 'link-local' | 'cgn' | 'metadata' | 'invalid';

export interface IpCheckResult {
  blocked: boolean;
  reason: IpBlockReason | null;
}

function parseIPv4Part(raw: string): number | null {
  if (raw === '') return null;
  let text = raw;
  let base = 10;
  if (/^0x[0-9a-f]+$/i.test(text)) {
    base = 16;
    text = text.slice(2);
  } else if (/^0[0-7]+$/.test(text)) {
    base = 8;
    text = text.slice(1);
  } else if (/^[0-9]+$/.test(text)) {
    base = 10;
  } else {
    return null;
  }
  if (text === '') return 0;
  const n = parseInt(text, base);
  return Number.isNaN(n) || n < 0 ? null : n;
}

/** "127.0.0.1" は勿論、"2130706433" (10進一括) や "0x7f.1" 等の短縮/難読化表記も受け付ける */
export function parseIPv4(host: string): [number, number, number, number] | null {
  if (!/^[0-9a-zA-Z.]+$/.test(host)) return null;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = parts.map(parseIPv4Part);
  if (nums.some((n) => n === null)) return null;
  const values = nums as number[];

  for (let i = 0; i < values.length - 1; i++) {
    if ((values[i] as number) > 255) return null;
  }
  const lastIndex = values.length - 1;
  let last = values[lastIndex] as number;
  const remainingCount = 4 - lastIndex;
  const maxLast = 256 ** remainingCount - 1;
  if (last > maxLast) return null;

  const bytes: number[] = values.slice(0, lastIndex);
  const lastBytes: number[] = new Array(remainingCount).fill(0);
  for (let i = remainingCount - 1; i >= 0; i--) {
    lastBytes[i] = last & 0xff;
    last = Math.floor(last / 256);
  }
  const full = [...bytes, ...lastBytes];
  return full as [number, number, number, number];
}

export function classifyIPv4(bytes: [number, number, number, number]): IpCheckResult {
  const [a, b] = bytes;
  if (a === 127) return { blocked: true, reason: 'loopback' };
  if (a === 0) return { blocked: true, reason: 'invalid' };
  if (a === 169 && b === 254) {
    if (bytes[2] === 169 && bytes[3] === 254) return { blocked: true, reason: 'metadata' };
    return { blocked: true, reason: 'link-local' };
  }
  if (a === 10) return { blocked: true, reason: 'private' };
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: 'private' };
  if (a === 192 && b === 168) return { blocked: true, reason: 'private' };
  if (a === 100 && b >= 64 && b <= 127) return { blocked: true, reason: 'cgn' };
  return { blocked: false, reason: null };
}

/** IPv6アドレスを16bitグループ8つ (0-65535) へ展開する。'::' 圧縮・埋め込みIPv4に対応 */
export function parseIPv6(rawHost: string): number[] | null {
  let host = rawHost;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === '') return null;

  // 埋め込みIPv4 (例: ::ffff:127.0.0.1, ::ffff:7f00:1 は下で別途処理)
  const lastColon = host.lastIndexOf(':');
  let embeddedV4: [number, number, number, number] | null = null;
  if (host.includes('.') && lastColon !== -1) {
    const v4part = host.slice(lastColon + 1);
    embeddedV4 = parseIPv4(v4part);
    if (!embeddedV4) return null;
    host = `${host.slice(0, lastColon + 1)}${embeddedV4[0].toString(16).padStart(2, '0')}${embeddedV4[1]
      .toString(16)
      .padStart(2, '0')}:${embeddedV4[2].toString(16).padStart(2, '0')}${embeddedV4[3].toString(16).padStart(2, '0')}`;
  }

  const parts = host.split('::');
  if (parts.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const groupStrs = s.split(':');
    const groups: number[] = [];
    for (const g of groupStrs) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  if (parts.length === 1) {
    const groups = parseGroups(parts[0] as string);
    if (!groups || groups.length !== 8) return null;
    return groups;
  }

  const head = parseGroups(parts[0] as string);
  const tail = parseGroups(parts[1] as string);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

function groupsToHex(groups: number[]): string {
  return groups.map((g) => g.toString(16).padStart(4, '0')).join(':');
}

export function classifyIPv6(groups: number[]): IpCheckResult {
  const hex = groupsToHex(groups);
  const isZero = (n: number) => n === 0;

  // ::1 loopback
  if (groups.slice(0, 7).every(isZero) && groups[7] === 1) {
    return { blocked: true, reason: 'loopback' };
  }
  // :: unspecified
  if (groups.every(isZero)) {
    return { blocked: true, reason: 'invalid' };
  }
  // fd00:ec2::254 (AWS IMDSv6 metadata)
  if (hex === 'fd00:0ec2:0000:0000:0000:0000:0000:0254') {
    return { blocked: true, reason: 'metadata' };
  }
  // IPv4-mapped ::ffff:0:0/96
  if (groups.slice(0, 5).every(isZero) && groups[5] === 0xffff) {
    const v4 = [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff] as [
      number,
      number,
      number,
      number,
    ];
    return classifyIPv4(v4);
  }
  // fe80::/10 link-local
  if ((groups[0]! & 0xffc0) === 0xfe80) {
    return { blocked: true, reason: 'link-local' };
  }
  // fc00::/7 unique local (private)
  if ((groups[0]! & 0xfe00) === 0xfc00) {
    return { blocked: true, reason: 'private' };
  }

  return { blocked: false, reason: null };
}

const KNOWN_BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata.internal', 'instance-data.ec2.internal']);

export function classifyHostname(hostnameRaw: string): IpCheckResult {
  const hostname = hostnameRaw.toLowerCase();

  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const groups = parseIPv6(hostname);
    if (groups) return classifyIPv6(groups);
    return { blocked: false, reason: null };
  }

  const v4 = parseIPv4(hostname);
  if (v4) return classifyIPv4(v4);

  const v6 = parseIPv6(hostname);
  if (v6) return classifyIPv6(v6);

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { blocked: true, reason: 'loopback' };
  }
  if (KNOWN_BLOCKED_HOSTNAMES.has(hostname)) {
    return { blocked: true, reason: 'metadata' };
  }

  return { blocked: false, reason: null };
}

/** 単一IPアドレス文字列 (v4/v6いずれか) を判定する。resolveAndCheck の解決結果に使う */
export function classifyIpAddress(ip: string): IpCheckResult {
  const v4 = parseIPv4(ip);
  if (v4) return classifyIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return classifyIPv6(v6);
  return { blocked: false, reason: null };
}
