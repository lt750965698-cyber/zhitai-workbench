export const MIN_MEAN_VOLUME_DB = -34;
export const MIN_MAX_VOLUME_DB = -18;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Validate that an audio QC report belongs to the exact bytes being delivered.
 * The caller maps the stable reason to an ingest or publish HTTP error code.
 */
export function validateAudioQualityReport(report, {
  sizeBytes,
  sha256,
  expectedSizeBytes = null,
  expectedSha256 = null,
  expectedJobId = null,
} = {}) {
  if (!report || typeof report !== "object") return { ok: false, reason: "missing" };
  const meanVolumeDb = finiteNumber(report.meanVolumeDb);
  const maxVolumeDb = finiteNumber(report.maxVolumeDb);
  if (report.status !== "passed"
    || meanVolumeDb === null
    || maxVolumeDb === null
    || meanVolumeDb < MIN_MEAN_VOLUME_DB
    || maxVolumeDb < MIN_MAX_VOLUME_DB) {
    return { ok: false, reason: "failed" };
  }

  const actualSize = finiteNumber(sizeBytes);
  const reportSize = finiteNumber(report.outputSizeBytes);
  const actualSha = String(sha256 || "");
  const reportSha = String(report.outputSha256 || "");
  if (actualSize === null
    || reportSize === null
    || reportSize !== actualSize
    || !actualSha
    || reportSha !== actualSha
    || (expectedSizeBytes !== null && finiteNumber(expectedSizeBytes) !== actualSize)
    || (expectedSha256 !== null && String(expectedSha256 || "") !== actualSha)
    || (expectedJobId !== null && String(report.jobId || "") !== String(expectedJobId))) {
    return { ok: false, reason: "integrity" };
  }

  return { ok: true, meanVolumeDb, maxVolumeDb };
}
