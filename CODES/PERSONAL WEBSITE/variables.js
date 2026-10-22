/*
 * Daybook configuration.
 *
 * Keep this file safe to commit: the values below are placeholders.  A
 * Supabase anon key is safe for a browser app, but never put a service-role
 * key in this file.  The runtime treats empty values as an intentional
 * offline/guest configuration.
 */
(function (window) {
  "use strict";

  if (!window) return;

  var existing = window.APP_CONFIG && typeof window.APP_CONFIG === "object"
    ? window.APP_CONFIG
    : {};

  var defaults = {
    APP_NAME: "DAYBOOK",
    APP_VERSION: "1.0.0",
    APP_DESCRIPTION: "An offline-first personal operating system for study, planning, spending, notes, and links.",
    APP_AUTHOR: "Fuad",
    APP_URL: "",
    STORAGE_KEY: "studyTrackerData",
    STORAGE_VERSION: 1,
    TIME_ZONE: "Asia/Dhaka",
    THEME_STORAGE_KEY: "daybook-theme",
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    SUPABASE_TABLE: "user_data",
    SUPABASE_CDN: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js",
    JSPDF_CDN: "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
    metadata: {
      name: "DAYBOOK",
      version: "1.0.0",
      description: "An offline-first personal dashboard."
    }
  };

  var config = {};
  var key;
  for (key in defaults) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      config[key] = defaults[key];
    }
  }
  for (key in existing) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      config[key] = existing[key];
    }
  }

  config.metadata = Object.assign({}, defaults.metadata, existing.metadata || {}, {
    name: config.APP_NAME,
    version: config.APP_VERSION,
    description: config.APP_DESCRIPTION
  });

  window.APP_CONFIG = config;
})(typeof window !== "undefined" ? window : null);
