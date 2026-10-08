/**
 * Central branding and metadata constants for CoAgent8.
 *
 * @packageDocumentation
 */

import { version } from '../package.json';

export const BRAND = {
  NAME: 'CoAgent8',
  TAGLINE: 'Cross-Agent CLI Bridge',
  PACKAGE_NAME: 'coagent8',
  SERVER_NAME: 'coagent8',
  SERVER_VERSION: version,
  GITHUB_OWNER: 'oktawianwybieralski',
  GITHUB_REPO: 'coagent8',
} as const;

