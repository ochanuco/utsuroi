-- ADR-0017: robots_policies.canonical_origin を `scheme://host[:port]` 表記へ正規化する。
--
-- pipeline は `new URL(source.url).origin` (末尾スラッシュ無し) で Policy を引くが、UI の
-- 対象Origin 入力は sites.primary_origin を初期値にしており、そこに `https://example.com/`
-- のような末尾スラッシュ付きの値が入りうる。照合は完全一致なので、この表記ゆれがあると
-- 設定済みの Override が引けず既定の enforce にフォールバックしてしまう。
--
-- 対象は「スラッシュがちょうど3つ = scheme://host[:port]/ の形」の行のみ。パスを含む値を
-- 誤って削らないための絞り込み。UNIQUE(site_id, canonical_origin) と衝突する場合
-- (正規化後の行が既にある場合) はスキップし、重複解消は運用判断に委ねる。
UPDATE robots_policies
SET canonical_origin = rtrim(canonical_origin, '/'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canonical_origin LIKE '%/'
  AND (length(canonical_origin) - length(replace(canonical_origin, '/', ''))) = 3
  AND NOT EXISTS (
    SELECT 1
    FROM robots_policies other
    WHERE other.site_id = robots_policies.site_id
      AND other.canonical_origin = rtrim(robots_policies.canonical_origin, '/')
  );
