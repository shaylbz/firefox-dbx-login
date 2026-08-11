// Chrome MV3 service-worker entry point.
// Loads the shared config (which also aliases `browser` to `chrome`) and the
// shared background logic. Firefox does not use this file — its MV2 manifest
// loads config.js + background.js directly as a persistent background page.
importScripts("config.js", "background.js");
