import { BlockList, isIP } from 'node:net';

// IPv4 と IPv6 の BlockList は分ける。同居させると IPv4 が ::/96 等の IPv6 規則に誤って一致する。
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();

const V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [net, prefix] of V4_RANGES) blockedV4.addSubnet(net, prefix, 'ipv4');

// IPv4 を埋め込める形式 (mapped / NAT64 / 6to4 / Teredo) は埋め込み先を個別に判定せず丸ごと拒否する。
const V6_RANGES: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of V6_RANGES) blockedV6.addSubnet(net, prefix, 'ipv6');

/** 組み込みの拒否範囲に加えて拒否する CIDR (例: 宅内ネットワークの公開アドレス) */
export interface ExtraBlockList {
  v4: BlockList;
  v6: BlockList;
}

/** `10.0.0.0/8, 2001:db8::/32` のようなカンマ・空白区切りの CIDR 列を解釈する。不正な要素があれば例外 */
export function parseCidrList(text: string): ExtraBlockList {
  const extra: ExtraBlockList = { v4: new BlockList(), v6: new BlockList() };
  for (const entry of text.split(/[\s,]+/).filter((e) => e !== '')) {
    const [network, prefixText, ...rest] = entry.split('/');
    const family = network === undefined ? 0 : isIP(network);
    const prefix = prefixText === undefined || !/^\d{1,3}$/.test(prefixText) ? NaN : Number(prefixText);
    if (family === 0 || rest.length > 0 || !Number.isInteger(prefix) || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(`invalid CIDR: ${entry}`);
    }
    if (family === 4) extra.v4.addSubnet(network as string, prefix, 'ipv4');
    else extra.v6.addSubnet(network as string, prefix, 'ipv6');
  }
  return extra;
}

export function isBlockedAddress(address: string, extra?: ExtraBlockList): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return blockedV4.check(address, 'ipv4') || (extra?.v4.check(address, 'ipv4') ?? false);
  return blockedV6.check(address, 'ipv6') || (extra?.v6.check(address, 'ipv6') ?? false);
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

/** DNS 解決前に弾けるホスト名 (名前によるメタデータ・ローカル参照) */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
