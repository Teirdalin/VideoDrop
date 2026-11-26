const googleApiKey = /AIza[0-9A-Za-z_-]{35}/;

export function removeBundledGoogleApiKeys(bundle) {
  const source = bundle.replace(/^    API_KEY: "(AIza[0-9A-Za-z_-]{35})",\r?\n/gm, '');
  assertNoBundledGoogleApiKeys(source);
  return source;
}

export function assertNoBundledGoogleApiKeys(bundle) {
  if (googleApiKey.test(bundle)) throw new Error('YouTube.js contains a hard-coded Google API key.');
}
