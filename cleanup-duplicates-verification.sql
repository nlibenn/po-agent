-- Verification query: Check for duplicate PDF attachments by content_sha256
-- Run this after cleanup to confirm duplicates are gone
-- Expected result: 0 rows (no duplicates)

SELECT 
  content_sha256,
  COUNT(*) as duplicate_count,
  GROUP_CONCAT(attachment_id) as attachment_ids
FROM attachments
WHERE content_sha256 IS NOT NULL
  AND mime_type = 'application/pdf'
GROUP BY content_sha256
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;

-- Alternative: Count total attachments vs unique content hashes
-- If these match, no duplicates exist
SELECT 
  (SELECT COUNT(*) FROM attachments WHERE mime_type = 'application/pdf' AND content_sha256 IS NOT NULL) as total_pdfs,
  (SELECT COUNT(DISTINCT content_sha256) FROM attachments WHERE mime_type = 'application/pdf' AND content_sha256 IS NOT NULL) as unique_hashes,
  (SELECT COUNT(*) FROM attachments WHERE mime_type = 'application/pdf' AND content_sha256 IS NOT NULL) - 
  (SELECT COUNT(DISTINCT content_sha256) FROM attachments WHERE mime_type = 'application/pdf' AND content_sha256 IS NOT NULL) as duplicate_count;
