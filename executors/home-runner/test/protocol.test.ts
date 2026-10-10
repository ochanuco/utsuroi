import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProtocolError, parseHeartbeatResponse, parseLeaseResponse, parseResultResponse } from '../src/protocol.ts';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`../../../test/fixtures/runner-protocol/${name}.json`, import.meta.url), 'utf8'));

test('parses the lease response fixture', () => {
  const parsed = parseLeaseResponse(fixture('lease-response'));
  assert.equal(parsed.jobs.length, 1);
  assert.equal(parsed.jobs[0]?.request.url, 'https://example.com/feed.xml');
  assert.deepEqual(parsed.jobs[0]?.request.headers, { 'user-agent': 'Mozilla/5.0 (compatible; example)', 'if-none-match': '"abc"' });
});

test('parses the heartbeat and result response fixtures', () => {
  assert.equal(parseHeartbeatResponse(fixture('heartbeat-response')).maintenance, false);
  assert.deepEqual(parseResultResponse(fixture('result-response-accepted')), { accepted: true });
  assert.deepEqual(parseResultResponse(fixture('result-response-duplicate')), { accepted: true, duplicate: true });
});

test('rejects malformed responses', () => {
  assert.throws(() => parseLeaseResponse({}), ProtocolError);
  assert.throws(() => parseLeaseResponse({ jobs: [{ jobId: 'a' }] }), ProtocolError);
  assert.throws(() => parseHeartbeatResponse({ serverTime: 'x' }), ProtocolError);
  const bad = fixture('lease-response');
  bad.jobs[0].request.maxBytes = 'big';
  assert.throws(() => parseLeaseResponse(bad), ProtocolError);
});
