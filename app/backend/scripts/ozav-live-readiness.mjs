import 'dotenv/config';
import { inspectCapabilities } from './lib/ozav-readiness.mjs';

// Deliberately separate from the API's OZAV_API_KEY. No database, writes or startup imports.
try {
  const report = await inspectCapabilities({
    key: process.env.OZAV_READINESS_API_KEY,
    expectedEnvironment: process.env.OZAV_READINESS_EXPECTED_ENVIRONMENT || 'live',
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.expected_environment_matches) process.exitCode = 1;
} catch (error) {
  const allowed = new Set(['OZAV_READINESS_KEY_REQUIRED', 'OZAV_EXPECTED_ENVIRONMENT_INVALID',
    'OZAV_KEY_ENVIRONMENT_MISMATCH', 'OZAV_READINESS_CONNECTION_UNCONFIRMED',
    'OZAV_READINESS_REQUEST_REFUSED', 'OZAV_CAPABILITIES_INVALID']);
  console.error(JSON.stringify({error: allowed.has(error?.message) ? error.message : 'OZAV_READINESS_UNCONFIRMED'}));
  process.exitCode = 1;
}
