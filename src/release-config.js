(function initializeReleaseConfig(root) {
  const version = '3.18.0-kinetic-overhaul';
  const release = Object.freeze({
    version,
    label: `v${version}`,
    channel: 'smooth-runtime',
    cacheName: `one-bullet-arena-v${version}`,
    schemaVersion: 1,
  });

  root.ONE_BULLET_RELEASE = release;
})(globalThis);
