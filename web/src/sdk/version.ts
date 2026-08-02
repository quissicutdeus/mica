/**
 * Centralized gPhone Versioning & Smart Build Information
 */

export const MICA_VERSION: string =
  typeof __MICA_VERSION__ !== 'undefined' ? __MICA_VERSION__ : '1.0.0';

export const MICA_BUILD_INFO: string =
  typeof __MICA_BUILD_INFO__ !== 'undefined' ? __MICA_BUILD_INFO__ : `v${MICA_VERSION}-dev`;
