/*
 * DAYBOOK / PERSONAL OS
 * Browser-only behavior layer.
 *
 * The runtime intentionally has no build-time dependencies.  It starts with
 * localStorage, adds Supabase only when both credentials are configured, and
 * uses event delegation so the HTML shell can stay small and declarative.
 */
(function (window, document) {
  "use strict";

  if (!window || !document) return;

  var config = window.APP_CONFIG || {};
  var APP_TIME_ZONE = String(config.TIME_ZONE || "Asia/Dhaka").trim() || "Asia/Dhaka";
  var BASE_STORAGE_KEY = String(config.STORAGE_KEY || "studyTrackerData");
  var LEGACY_STUDY_KEY = "fuad_study_tracker_v1";
  var SUPABASE_TABLE = String(config.SUPABASE_TABLE || "user_data");
  var COLLECTIONS = [
    "tasks",
    "dailyTargets",
    "routines",
    "expenses",
    "tuitions",
    "notes",
    "links",
    "syllabusProgress",
    "nextDayTargets"
  ];

  var COLLECTION_ALIASES = {
    tasks: ["tasks", "todos", "toDos", "taskList", "plannerTasks"],
    dailyTargets: ["dailyTargets", "daily_targets", "dailyGoals", "targets", "goals"],
    routines: ["routines", "routine", "habits", "classRoutines", "classRoutine"],
    expenses: ["expenses", "expense", "spending", "spendings", "costs", "entries", "ledger"],
    tuitions: ["tuitions", "tuition", "studentTuitions", "tuitionStudents"],
    notes: ["notes", "note", "memos", "dailyNotes"],
    links: ["links", "link", "bookmarks", "resources", "essentialLinks"],
    syllabusProgress: ["syllabusProgress", "syllabus_progress", "studyProgress", "subjects", "courses", "progress"],
    nextDayTargets: ["nextDayTargets", "next_day_targets", "tomorrowTargets", "tomorrow", "nextTargets"]
  };

  var state = {
    booted: false,
    authMode: "signin",
    isGuest: false,
    session: null,
    user: null,
    supabase: null,
    cloudReady: false,
    cloudError: "",
    currentView: "overview",
    data: createDefaultData(),
    syncTimer: null,
    toastTimer: null,
    clockTimer: null,
    hoverAudioContext: null,
    hoverAudioArmed: false,
    lastHoverSoundAt: 0,
    noteTimers: {},
    spendingMonth: "",
    spendingSelectedDate: "",
    theme: "light",
    lastTodayIso: ""
  };

  var App = {
    state: state,
    config: config
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function dateOnly(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : "";
  }

  function datePartsInZone(value) {
    var date = value instanceof Date ? value : null;
    if (!date && dateOnly(value)) date = new Date(dateOnly(value) + "T12:00:00Z");
    if (!date && value != null) date = new Date(value);
    if (!date || Number.isNaN(date.getTime())) return null;
    try {
      var parts = new Intl.DateTimeFormat("en-US", {
        timeZone: APP_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(date).reduce(function (result, part) {
        if (part.type !== "literal") result[part.type] = part.value;
        return result;
      }, {});
      if (!parts.year || !parts.month || !parts.day) return null;
      return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day)
      };
    } catch (error) {
      return null;
    }
  }

  function zonedDateKey(value) {
    var direct = dateOnly(value);
    if (direct) return direct;
    var parts = datePartsInZone(value);
    if (!parts) return "";
    return String(parts.year).padStart(4, "0") + "-" + String(parts.month).padStart(2, "0") + "-" + String(parts.day).padStart(2, "0");
  }

  function todayIso() {
    return zonedDateKey(new Date());
  }

  function validMonthKey(value) {
    return /^\d{4}-\d{2}$/.test(text(value)) && Number(text(value).slice(5, 7)) >= 1 && Number(text(value).slice(5, 7)) <= 12;
  }

  function monthKeyFor(value) {
    var key = zonedDateKey(value) || todayIso();
    return key.slice(0, 7);
  }

  function isoDateToUtc(value) {
    var key = zonedDateKey(value);
    if (!key) return null;
    var parts = key.split("-").map(Number);
    var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function utcDateToIso(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0");
  }

  function shiftMonth(monthKey, amount) {
    var key = validMonthKey(monthKey) ? monthKey : monthKeyFor(new Date());
    var parts = key.split("-").map(Number);
    return utcDateToIso(new Date(Date.UTC(parts[0], parts[1] - 1 + Number(amount || 0), 1))).slice(0, 7);
  }

  function daysInMonth(monthKey) {
    var key = validMonthKey(monthKey) ? monthKey : monthKeyFor(new Date());
    var parts = key.split("-").map(Number);
    return new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate();
  }

  function monthLabel(monthKey) {
    var key = validMonthKey(monthKey) ? monthKey : monthKeyFor(new Date());
    var date = new Date(key + "-01T12:00:00Z");
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(date).toUpperCase();
    } catch (error) {
      return key;
    }
  }

  function dateDifference(start, end) {
    var startDate = isoDateToUtc(start);
    var endDate = isoDateToUtc(end);
    if (!startDate || !endDate) return NaN;
    return Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
  }

  function isWithinRecentDays(value, endDate, days) {
    var difference = dateDifference(zonedDateKey(value), endDate || todayIso());
    return Number.isFinite(difference) && difference >= 0 && difference < Number(days || 1);
  }

  function uid(prefix) {
    var lead = prefix || "record";
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return lead + "_" + window.crypto.randomUUID();
      }
    } catch (error) {
      // Fall through to the browser-safe timestamp/random fallback.
    }
    return lead + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function qs(selector, root) {
    try {
      return (root || document).querySelector(selector);
    } catch (error) {
      return null;
    }
  }

  function qsa(selector, root) {
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(selector));
    } catch (error) {
      return [];
    }
  }

  function first(selectors, root) {
    var list = Array.isArray(selectors) ? selectors : [selectors];
    for (var i = 0; i < list.length; i += 1) {
      var found = qs(list[i], root);
      if (found) return found;
    }
    return null;
  }

  function text(value) {
    return value == null ? "" : String(value);
  }

  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function sanitizeUrl(value) {
    var raw = text(value).trim();
    if (!raw) return "#";
    if (/^(https?:|mailto:|tel:)/i.test(raw)) return raw;
    return "https://" + raw;
  }

  function safeNumber(value, fallback) {
    if (value === "" || value == null) return fallback == null ? 0 : fallback;
    var number = Number(value);
    return Number.isFinite(number) ? number : (fallback == null ? 0 : fallback);
  }

  function safeBoolean(value, fallback) {
    if (typeof value === "boolean") return value;
    if (value == null || value === "") return !!fallback;
    if (typeof value === "number") return value !== 0;
    var normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y", "done", "complete", "completed", "on"].indexOf(normalized) >= 0) return true;
    if (["false", "0", "no", "n", "open", "pending", "off"].indexOf(normalized) >= 0) return false;
    return !!fallback;
  }

  function normalizeTheme(value) {
    return String(value || "").toLowerCase() === "dark" ? "dark" : "light";
  }

  function isObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value;
    }
  }

  function storage() {
    try {
      return window.localStorage;
    } catch (error) {
      return null;
    }
  }

  function readJson(key) {
    var store = storage();
    if (!store) return null;
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function writeJson(key, value) {
    var store = storage();
    if (!store) return false;
    try {
      store.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  function currentStorageKey() {
    if (state.user && state.user.id) return BASE_STORAGE_KEY + ":" + state.user.id;
    return BASE_STORAGE_KEY;
  }

  function createDefaultData() {
    return {
      schemaVersion: Number(config.STORAGE_VERSION || 1),
      updatedAt: nowIso(),
      profile: {},
      settings: {
        accentMode: true,
        dailyCheckin: true,
        theme: "light"
      },
      tasks: [],
      dailyTargets: [],
      routines: [],
      expenses: [],
      tuitions: [],
      notes: [],
      links: [],
      syllabusProgress: [],
      nextDayTargets: [],
      studyProgress: {
        done: {},
        notes: {}
      }
    };
  }

  function firstValue(source, keys, fallback) {
    if (!source) return fallback;
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
    }
    return fallback;
  }

  function asRecordArray(value) {
    if (Array.isArray(value)) return value.slice();
    if (!isObject(value)) return [];
    return Object.keys(value).map(function (key) {
      var item = value[key];
      if (isObject(item)) return Object.assign({ id: key }, item);
      return { id: key, title: key, value: item };
    });
  }

  function normalizeRecord(kind, input, index) {
    var source = isObject(input) ? Object.assign({}, input) : { value: input };
    var record = Object.assign({}, source);
    record.id = text(source.id || source.key || uid(kind.slice(0, -1) || kind));
    record.createdAt = source.createdAt || source.created_at || nowIso();
    record.updatedAt = source.updatedAt || source.updated_at || record.createdAt;

    if (kind === "tasks") {
      record.title = text(firstValue(source, ["title", "label", "name", "task", "text"], "Task " + (index + 1)));
      record.due = text(firstValue(source, ["due", "dueDate", "date", "deadline"], ""));
      record.priority = text(firstValue(source, ["priority", "importance"], "normal"));
      record.project = text(firstValue(source, ["project", "area", "category", "context"], ""));
      record.completed = safeBoolean(firstValue(source, ["completed", "complete", "done", "isDone"], false));
      record.status = record.completed ? "done" : text(source.status || "open");
    }

    if (kind === "dailyTargets") {
      record.title = text(firstValue(source, ["title", "label", "name", "target", "goal"], "Daily target " + (index + 1)));
      record.target = safeNumber(firstValue(source, ["target", "goal", "quantity", "hours", "value"], 0));
      record.unit = text(firstValue(source, ["unit", "measure"], "")).trim();
      record.date = text(firstValue(source, ["date", "day", "targetDate"], todayIso()));
      record.completed = safeBoolean(firstValue(source, ["completed", "complete", "done", "isDone"], false));
    }

    if (kind === "routines") {
      record.title = text(firstValue(source, ["title", "label", "name", "routine"], "Routine " + (index + 1)));
      record.time = text(firstValue(source, ["time", "start", "at"], ""));
      record.frequency = text(firstValue(source, ["frequency", "repeat", "days"], "daily"));
      record.active = safeBoolean(firstValue(source, ["active", "enabled", "isActive"], true), true);
      record.completed = safeBoolean(firstValue(source, ["completed", "complete", "done", "isDone"], false));
    }

    if (kind === "expenses") {
      record.label = text(firstValue(source, ["label", "title", "name", "description", "where", "note"], "Expense " + (index + 1)));
      record.title = record.label;
      record.amount = safeNumber(firstValue(source, ["amount", "cost", "value", "price", "total"], 0));
      record.category = text(firstValue(source, ["category", "type", "group"], "everyday"));
      record.date = text(firstValue(source, ["date", "spentAt", "created"], todayIso()));
      record.note = text(firstValue(source, ["note", "memo", "details"], ""));
    }

    if (kind === "tuitions") {
      record.name = text(firstValue(source, ["name", "student", "studentName", "title", "label"], "Tuition " + (index + 1)));
      record.title = record.name;
      record.salary = safeNumber(firstValue(source, ["salary", "amount", "fee", "monthlySalary", "pay", "value"], 0));
      record.phone = text(firstValue(source, ["phone", "mobile", "contact", "telephone"], ""));
      record.address = text(firstValue(source, ["address", "location", "area"], ""));
      record.subject = text(firstValue(source, ["subject", "course", "class", "topic"], ""));
      record.notes = text(firstValue(source, ["notes", "note", "details", "description"], ""));
      record.paid = safeBoolean(firstValue(source, ["paid", "ticked", "isPaid", "completed", "complete", "done"], false));
      record.ticked = record.paid;
      record.completed = record.paid;
      record.status = record.paid ? "paid" : "unpaid";
    }

    if (kind === "notes") {
      record.title = text(firstValue(source, ["title", "label", "name", "heading"], "Untitled note"));
      record.content = text(firstValue(source, ["content", "body", "text", "note", "description"], ""));
      record.tag = text(firstValue(source, ["tag", "tags", "category"], ""));
      record.pinned = safeBoolean(firstValue(source, ["pinned", "isPinned"], false));
    }

    if (kind === "links") {
      record.label = text(firstValue(source, ["label", "title", "name", "text"], "Saved link"));
      record.title = record.label;
      record.url = text(firstValue(source, ["url", "href", "link"], ""));
      record.category = text(firstValue(source, ["category", "collection", "type"], "reference"));
    }

    if (kind === "syllabusProgress") {
      record.subject = text(firstValue(source, ["subject", "course", "title", "name", "label"], "Subject " + (index + 1)));
      record.title = record.subject;
      record.topic = text(firstValue(source, ["topic", "unit", "description"], ""));
      record.total = safeNumber(firstValue(source, ["total", "totalTopics", "count"], 0));
      record.completed = safeNumber(firstValue(source, ["completed", "done", "completedTopics"], 0));
      record.progress = Math.max(0, Math.min(100, safeNumber(firstValue(source, ["progress", "percent", "pct"], record.total ? (record.completed / record.total) * 100 : 0))));
    }

    if (kind === "nextDayTargets") {
      record.title = text(firstValue(source, ["title", "label", "name", "target", "goal"], "Next-day target " + (index + 1)));
      record.date = text(firstValue(source, ["date", "targetDate", "day"], ""));
      record.completed = safeBoolean(firstValue(source, ["completed", "complete", "done", "isDone"], false));
      record.priority = text(firstValue(source, ["priority", "importance"], "normal"));
      record.notes = text(firstValue(source, ["notes", "note", "details"], ""));
    }

    return record;
  }

  function normalizeStudyProgress(source) {
    var study = {
      done: {},
      notes: {}
    };
    var candidate = source && (source.studyProgress || source.study || source.progressState);
    if (isObject(candidate)) {
      if (isObject(candidate.done)) study.done = Object.assign({}, candidate.done);
      if (isObject(candidate.notes)) study.notes = Object.assign({}, candidate.notes);
    }
    if (isObject(source && source.done)) study.done = Object.assign({}, study.done, source.done);
    if (isObject(source && source.topicDone)) study.done = Object.assign({}, study.done, source.topicDone);
    if (isObject(source && source.topicNotes)) study.notes = Object.assign({}, study.notes, source.topicNotes);
    return study;
  }

  function normalizeData(raw) {
    var source = isObject(raw) && isObject(raw.data) ? raw.data : (isObject(raw) ? raw : {});
    var data = createDefaultData();
    data.schemaVersion = Number(source.schemaVersion || source.version || data.schemaVersion);
    data.updatedAt = source.updatedAt || source.updated_at || data.updatedAt;
    data.profile = isObject(source.profile) ? Object.assign({}, source.profile) : {};
    data.settings = Object.assign({}, data.settings, isObject(source.settings) ? source.settings : {});
    data.settings.theme = normalizeTheme(data.settings.theme);
    data.studyProgress = normalizeStudyProgress(source);

    COLLECTIONS.forEach(function (kind) {
      var sourceValue = null;
      var aliases = COLLECTION_ALIASES[kind] || [kind];
      for (var i = 0; i < aliases.length; i += 1) {
        if (source[aliases[i]] !== undefined && source[aliases[i]] !== null) {
          sourceValue = source[aliases[i]];
          break;
        }
      }
      if (kind === "syllabusProgress" && isObject(sourceValue) && (sourceValue.done || sourceValue.notes)) {
        sourceValue = null;
      }
      data[kind] = asRecordArray(sourceValue).map(function (item, index) {
        return normalizeRecord(kind, item, index);
      });
    });

    // Some early tracker exports kept course progress as an object map.  Keep
    // those entries available in the dashboard even without study-data.js.
    if (!data.syllabusProgress.length && isObject(source.progress)) {
      data.syllabusProgress = Object.keys(source.progress).map(function (key, index) {
        return normalizeRecord("syllabusProgress", {
          id: key,
          subject: key,
          progress: source.progress[key]
        }, index);
      });
    }

    return data;
  }

  function mergeStudyProgress(target, source) {
    if (!source) return target;
    var study = normalizeStudyProgress(source);
    target.studyProgress.done = Object.assign({}, study.done, target.studyProgress.done);
    target.studyProgress.notes = Object.assign({}, study.notes, target.studyProgress.notes);
    return target;
  }

  function readCandidateKeys() {
    var keys = [currentStorageKey(), BASE_STORAGE_KEY, "daybook-data-v1", "daybookData", "study-tracker-data", "study_tracker_data", "studyTracker", "trackerData", "studyData", LEGACY_STUDY_KEY];
    var store = storage();
    if (store) {
      try {
        for (var i = 0; i < store.length; i += 1) {
          var key = store.key(i);
          if (key && /study|tracker|daybook/i.test(key) && keys.indexOf(key) === -1) keys.push(key);
        }
      } catch (error) {
        // Storage access is best-effort; the default data remains usable.
      }
    }
    return keys;
  }

  function loadLocalData() {
    var data = null;
    var keys = readCandidateKeys();
    for (var i = 0; i < keys.length; i += 1) {
      var candidate = readJson(keys[i]);
      if (candidate && isObject(candidate)) {
        data = normalizeData(candidate);
        break;
      }
    }
    if (!data) data = createDefaultData();

    // Always merge the original study tracker key when it exists.  The exact
    // `semId::courseCode::topicIndex` keys remain intact for round-tripping.
    var legacyStudy = readJson(LEGACY_STUDY_KEY);
    if (legacyStudy) mergeStudyProgress(data, legacyStudy);
    return data;
  }

  function saveLocalData() {
    state.data.updatedAt = nowIso();
    var serialized = clone(state.data);
    var ok = writeJson(currentStorageKey(), serialized);

    // Keep the unscoped key useful for guests and for the original tracker.
    if (!state.user) {
      ok = writeJson(BASE_STORAGE_KEY, serialized) && ok;
    }
    writeJson(LEGACY_STUDY_KEY, {
      done: Object.assign({}, state.data.studyProgress && state.data.studyProgress.done),
      notes: Object.assign({}, state.data.studyProgress && state.data.studyProgress.notes)
    });
    return ok;
  }

  function setSyncStatus(label, mode) {
    var value = text(label || "LOCAL / READY");
    var targets = qsa(".sidebar-status strong, [data-sync-status], .topbar__mode");
    targets.forEach(function (element) {
      if (element.classList.contains("topbar__mode")) {
        element.innerHTML = '<span class="status-dot" aria-hidden="true"></span> ' + escapeHtml(value);
      } else {
        element.textContent = value;
      }
      if (mode) element.dataset.syncMode = mode;
    });
    var root = qs("#app-root");
    if (root) root.dataset.syncState = mode || "local";
  }

  function setBootStatus(message, progress) {
    var status = qs("#boot-status");
    if (status) status.textContent = message;
    var value = qs(".boot-progress__value");
    if (value && progress != null) value.textContent = "/ / / " + Math.round(progress) + "%";
    var fill = qs(".boot-progress__fill");
    if (fill && progress != null) fill.style.width = Math.max(0, Math.min(100, progress)) + "%";
  }

  function showScreen(element, visible) {
    if (!element) return;
    element.hidden = !visible;
    element.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  function showBoot(visible) {
    showScreen(qs("#boot-screen"), visible);
  }

  function showAuth(visible) {
    showScreen(qs("#auth-screen"), visible);
    showScreen(qs("#app-root"), !visible);
  }

  function showApp() {
    showScreen(qs("#auth-screen"), false);
    showScreen(qs("#app-root"), true);
  }

  function showAuthMessage(message, kind) {
    var element = qs("#auth-message");
    if (!element) return;
    element.textContent = message || "";
    element.dataset.state = kind || "info";
  }

  function showToast(message, kind) {
    var toast = qs("#toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast";
      toast.className = "toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      toast.innerHTML = '<span class="toast__mark" aria-hidden="true">✓</span><span class="toast__message"></span><button class="toast__close" type="button" aria-label="Dismiss notification">×</button>';
      document.body.appendChild(toast);
    }
    var messageElement = qs(".toast__message", toast);
    if (messageElement) messageElement.textContent = message || "Saved.";
    toast.dataset.state = kind || "success";
    toast.hidden = false;
    toast.classList.add("is-visible");
    if (state.toastTimer) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () {
      toast.hidden = true;
      toast.classList.remove("is-visible");
    }, kind === "error" ? 6500 : 3200);
  }

  function formatMoney(amount) {
    var number = safeNumber(amount, 0);
    try {
      return "৳" + new Intl.NumberFormat("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number);
    } catch (error) {
      return "৳" + number.toFixed(2);
    }
  }

  function formatDate(value, options) {
    if (!value) return "";
    var date = new Date(dateOnly(value) ? dateOnly(value) + "T12:00:00Z" : value);
    if (Number.isNaN(date.getTime())) return text(value);
    try {
      var dateOptions = Object.assign({}, options || { month: "short", day: "numeric" }, { timeZone: APP_TIME_ZONE });
      return new Intl.DateTimeFormat("en-US", dateOptions).format(date);
    } catch (error) {
      return text(value);
    }
  }

  function recordComplete(record) {
    if (record && (record.paid !== undefined || record.ticked !== undefined) && record.name !== undefined) {
      return safeBoolean(firstValue(record, ["paid", "ticked", "completed", "done"], false));
    }
    return safeBoolean(firstValue(record, ["completed", "complete", "done", "isDone"], false));
  }

  function tuitionPaid(record) {
    return safeBoolean(firstValue(record, ["paid", "ticked", "completed", "done"], false));
  }

  function collectionFor(value) {
    var raw = text(value).trim();
    var map = {
      task: "tasks",
      tasks: "tasks",
      "daily-target": "dailyTargets",
      "daily-targets": "dailyTargets",
      dailyTarget: "dailyTargets",
      dailyTargets: "dailyTargets",
      routine: "routines",
      routines: "routines",
      expense: "expenses",
      expenses: "expenses",
      tuition: "tuitions",
      tuitions: "tuitions",
      note: "notes",
      notes: "notes",
      link: "links",
      links: "links",
      syllabus: "syllabusProgress",
      syllabusProgress: "syllabusProgress",
      "next-day": "nextDayTargets",
      "next-day-target": "nextDayTargets",
      "next-day-targets": "nextDayTargets",
      nextDayTargets: "nextDayTargets"
    };
    return map[raw] || (COLLECTIONS.indexOf(raw) >= 0 ? raw : "");
  }

  function findForm(kind) {
    var collection = collectionFor(kind);
    var selectors = {
      tasks: ["#task-form", 'form[data-form="task"]', 'form[data-record-type="tasks"]'],
      dailyTargets: ["#daily-target-form", 'form[data-form="daily-target"]', 'form[data-record-type="dailyTargets"]'],
      routines: ["#routine-form", 'form[data-form="routine"]', 'form[data-record-type="routines"]'],
      expenses: ["#expense-form", 'form[data-form="expense"]', 'form[data-record-type="expenses"]'],
      tuitions: ["#tuition-form", 'form[data-form="tuition"]', 'form[data-record-type="tuitions"]'],
      notes: ["#note-form", 'form[data-form="note"]', 'form[data-record-type="notes"]'],
      links: ["#link-form", 'form[data-form="link"]', 'form[data-record-type="links"]'],
      syllabusProgress: ["#syllabus-form", 'form[data-form="syllabus"]', 'form[data-record-type="syllabusProgress"]'],
      nextDayTargets: ["#next-day-target-form", 'form[data-form="next-day"]', 'form[data-record-type="nextDayTargets"]']
    };
    return first(selectors[collection] || []);
  }

  function formKind(form) {
    if (!form) return "";
    var value = form.dataset.form || form.dataset.recordType || form.id || "";
    value = value.replace(/-form$/, "");
    return collectionFor(value);
  }

  function fieldValue(form, names, fallback) {
    var list = Array.isArray(names) ? names : [names];
    for (var i = 0; i < list.length; i += 1) {
      var field = qs('[name="' + list[i] + '"]', form) || qs('[data-field="' + list[i] + '"]', form) || qs("#" + list[i], form);
      if (field) {
        if (field.type === "checkbox") return field.checked;
        return field.value;
      }
    }
    return fallback;
  }

  function formToRecord(form, kind, existing) {
    var collection = collectionFor(kind);
    var record = Object.assign({}, existing || {});
    if (window.FormData) {
      try {
        var formData = new FormData(form);
        formData.forEach(function (value, key) {
          if (key && key !== "id" && key !== "_method") record[key] = value;
        });
      } catch (error) {
        // The explicit field reads below still cover the contract forms.
      }
    }
    qsa("input[type=checkbox][name]", form).forEach(function (input) {
      record[input.name] = input.checked;
    });
    record.id = form.dataset.editingId || record.id || uid(collection.slice(0, -1));

    if (collection === "tasks") {
      record.title = text(fieldValue(form, ["title", "label", "name"], record.title));
      record.due = text(fieldValue(form, ["due", "dueDate", "date"], record.due || ""));
      record.priority = text(fieldValue(form, ["priority"], record.priority || "normal"));
      record.project = text(fieldValue(form, ["project", "area", "category"], record.project || ""));
    }
    if (collection === "dailyTargets") {
      record.title = text(fieldValue(form, ["title", "label", "target", "name"], record.title));
      record.target = safeNumber(fieldValue(form, ["target", "goal", "hours", "quantity"], record.target || 0));
      record.unit = text(fieldValue(form, ["unit", "measure"], record.unit || ""));
      record.date = text(fieldValue(form, ["date", "targetDate"], record.date || todayIso()));
    }
    if (collection === "routines") {
      record.title = text(fieldValue(form, ["title", "label", "name"], record.title));
      record.time = text(fieldValue(form, ["time", "start"], record.time || ""));
      record.frequency = text(fieldValue(form, ["frequency", "repeat", "days"], record.frequency || "daily"));
    }
    if (collection === "expenses") {
      record.label = text(fieldValue(form, ["label", "title", "name", "description"], record.label || record.title));
      record.title = record.label;
      record.amount = safeNumber(fieldValue(form, ["amount", "cost", "value"], record.amount || 0));
      record.category = text(fieldValue(form, ["category", "type"], record.category || "everyday"));
      record.date = text(fieldValue(form, ["date", "spentAt"], record.date || todayIso()));
    }
    if (collection === "tuitions") {
      record.name = text(fieldValue(form, ["name", "student", "studentName", "title", "label"], record.name || record.title));
      record.title = record.name;
      record.salary = safeNumber(fieldValue(form, ["salary", "amount", "fee", "monthlySalary", "pay", "value"], record.salary || 0));
      record.phone = text(fieldValue(form, ["phone", "mobile", "contact", "telephone"], record.phone || ""));
      record.address = text(fieldValue(form, ["address", "location", "area"], record.address || ""));
      record.subject = text(fieldValue(form, ["subject", "course", "class", "topic"], record.subject || ""));
      record.notes = text(fieldValue(form, ["notes", "note", "details", "description"], record.notes || ""));
      record.paid = safeBoolean(fieldValue(form, ["paid", "ticked", "isPaid", "completed", "done"], record.paid || record.ticked || false));
      record.ticked = record.paid;
      record.completed = record.paid;
      record.status = record.paid ? "paid" : "unpaid";
    }
    if (collection === "notes") {
      record.title = text(fieldValue(form, ["title", "label", "name"], record.title));
      record.content = text(fieldValue(form, ["content", "body", "text", "note"], record.content));
      record.tag = text(fieldValue(form, ["tag", "tags", "category"], record.tag || ""));
    }
    if (collection === "links") {
      record.label = text(fieldValue(form, ["label", "title", "name"], record.label || record.title));
      record.title = record.label;
      record.url = text(fieldValue(form, ["url", "href", "link"], record.url || ""));
      record.category = text(fieldValue(form, ["category", "collection", "type"], record.category || "reference"));
    }
    if (collection === "syllabusProgress") {
      record.subject = text(fieldValue(form, ["subject", "course", "title", "name"], record.subject || record.title));
      record.title = record.subject;
      record.total = safeNumber(fieldValue(form, ["total", "totalTopics"], record.total || 0));
      record.completed = safeNumber(fieldValue(form, ["completed", "done", "completedTopics"], record.completed || 0));
      record.progress = safeNumber(fieldValue(form, ["progress", "percent", "pct"], record.progress || 0));
    }
    if (collection === "nextDayTargets") {
      record.title = text(fieldValue(form, ["title", "label", "target", "name"], record.title));
      record.date = text(fieldValue(form, ["date", "targetDate"], record.date || ""));
      record.priority = text(fieldValue(form, ["priority"], record.priority || "normal"));
      record.notes = text(fieldValue(form, ["notes", "note", "details"], record.notes || ""));
    }

    return normalizeRecord(collection, record, 0);
  }

  function validateRecord(kind, record) {
    if (kind === "expenses") return record.label.trim() && record.amount >= 0;
    if (kind === "tuitions") return record.name.trim() && record.salary >= 0;
    if (kind === "links") return record.label.trim() && record.url.trim();
    if (kind === "notes") return record.title.trim() && record.content.trim();
    if (kind === "syllabusProgress") return record.subject.trim();
    return text(record.title).trim();
  }

  function findRecord(kind, id) {
    var collection = collectionFor(kind);
    if (!collection || !Array.isArray(state.data[collection])) return null;
    for (var i = 0; i < state.data[collection].length; i += 1) {
      if (text(state.data[collection][i].id) === text(id)) return state.data[collection][i];
    }
    return null;
  }

  function queueRemoteSync() {
    if (!state.supabase || !state.session || !state.cloudReady) return;
    if (state.syncTimer) window.clearTimeout(state.syncTimer);
    state.syncTimer = window.setTimeout(function () {
      syncRemote().catch(function () {
        setSyncStatus("LOCAL / READY", "local");
      });
    }, 500);
  }

  function persist(message) {
    var saved = saveLocalData();
    queueRemoteSync();
    renderAll();
    if (message) showToast(message, saved ? "success" : "error");
    if (!saved) setSyncStatus("LOCAL / READ ONLY", "local-error");
    return saved;
  }

  function makeActionButtons(kind, record, options) {
    var collection = collectionFor(kind);
    var id = escapeHtml(record.id);
    var buttons = [];
    if (!options || options.toggle !== false) {
      buttons.push('<button class="button button--small button--outline daybook-action" type="button" data-action="toggle-record" data-record-type="' + collection + '" data-id="' + id + '" aria-pressed="' + (recordComplete(record) ? "true" : "false") + '">' + (recordComplete(record) ? "UNDO" : "DONE") + '</button>');
    }
    buttons.push('<button class="button button--small button--outline daybook-action" type="button" data-action="edit-record" data-record-type="' + collection + '" data-id="' + id + '">EDIT</button>');
    buttons.push('<button class="button button--small button--outline daybook-action" type="button" data-action="delete-record" data-record-type="' + collection + '" data-id="' + id + '">DELETE</button>');
    return '<div class="daybook-actions">' + buttons.join("") + "</div>";
  }

  function emptyMarkup(message) {
    return '<div class="daybook-empty"><span class="empty-content__glyph" aria-hidden="true">↘</span><strong>' + escapeHtml(message) + '</strong><small>ADD SOMETHING WHEN YOU ARE READY.</small></div>';
  }

  function taskMarkup(record) {
    return '<article class="daybook-record daybook-task ' + (recordComplete(record) ? "is-complete" : "") + '" data-record-id="' + escapeHtml(record.id) + '" data-record-type="tasks">' +
      '<div class="daybook-record__main"><span class="daybook-check" aria-hidden="true">' + (recordComplete(record) ? "✓" : "") + '</span><div><strong>' + escapeHtml(record.title) + '</strong><small>' + escapeHtml(record.project || "PERSONAL") + (record.due ? " · DUE " + escapeHtml(formatDate(record.due).toUpperCase()) : "") + '</small></div></div>' +
      '<span class="daybook-chip">' + escapeHtml(text(record.priority || "normal").toUpperCase()) + '</span>' +
      makeActionButtons("tasks", record) +
      '</article>';
  }

  function dailyTargetMarkup(record) {
    return '<article class="daybook-record ' + (recordComplete(record) ? "is-complete" : "") + '" data-record-id="' + escapeHtml(record.id) + '" data-record-type="dailyTargets"><div class="daybook-record__main"><span class="daybook-check" aria-hidden="true">' + (recordComplete(record) ? "✓" : "") + '</span><div><strong>' + escapeHtml(record.title) + '</strong><small>' + escapeHtml(record.target || 0) + (record.unit ? " " + escapeHtml(record.unit) : "") + " · " + escapeHtml(record.date || todayIso()) + '</small></div></div>' + makeActionButtons("dailyTargets", record) + '</article>';
  }

  function routineMarkup(record) {
    var complete = recordComplete(record);
    return '<article class="daybook-record ' + (complete ? "is-complete" : "") + '" data-record-id="' + escapeHtml(record.id) + '" data-record-type="routines"><div class="daybook-record__main"><span class="daybook-check" aria-hidden="true">' + (complete ? "✓" : "") + '</span><div><strong>' + escapeHtml(record.title) + '</strong><small>' + escapeHtml(record.time || "ANY TIME") + " · " + escapeHtml(record.frequency || "DAILY") + '</small></div></div>' + makeActionButtons("routines", record) + '</article>';
  }

  function nextDayMarkup(record) {
    return '<article class="daybook-record ' + (recordComplete(record) ? "is-complete" : "") + '" data-record-id="' + escapeHtml(record.id) + '" data-record-type="nextDayTargets"><div class="daybook-record__main"><span class="daybook-check" aria-hidden="true">' + (recordComplete(record) ? "✓" : "") + '</span><div><strong>' + escapeHtml(record.title) + '</strong><small>' + escapeHtml(record.date || "TOMORROW") + (record.notes ? " · " + escapeHtml(record.notes) : "") + '</small></div></div>' + makeActionButtons("nextDayTargets", record) + '</article>';
  }

  function tuitionMarkup(record) {
    var paid = tuitionPaid(record);
    var statusLabel = paid ? "PAID" : "OPEN";
    return '<article class="tuition-card ' + (paid ? "is-paid" : "") + '" data-record-id="' + escapeHtml(record.id) + '" data-record-type="tuitions">' +
      '<div class="tuition-card__top"><span>TUITION / ' + escapeHtml(statusLabel) + '</span><span>' + escapeHtml(text(record.subject || "PRIVATE TUITION").toUpperCase()) + '</span></div>' +
      '<h2>' + escapeHtml(record.name) + '</h2>' +
      '<p class="tuition-card__subject">' + escapeHtml(record.subject || "SUBJECT / NOT SET") + '</p>' +
      '<dl class="tuition-card__details"><div><dt>SALARY</dt><dd>' + formatMoney(record.salary) + '</dd></div><div><dt>PHONE</dt><dd>' + escapeHtml(record.phone || "NOT ADDED") + '</dd></div><div><dt>ADDRESS</dt><dd>' + escapeHtml(record.address || "NOT ADDED") + '</dd></div><div><dt>PAYMENT</dt><dd>' + (paid ? "PAID" : "NOT PAID") + '</dd></div></dl>' +
      (record.notes ? '<p class="tuition-card__note">' + escapeHtml(record.notes) + '</p>' : '') +
      '<div class="tuition-card__footer"><button class="tuition-card__check" type="button" data-action="toggle-record" data-toggle-field="paid" data-record-type="tuitions" data-id="' + escapeHtml(record.id) + '" aria-pressed="' + (paid ? "true" : "false") + '"><span aria-hidden="true">✓</span> ' + (paid ? "PAID / UNCHECK" : "MARK AS PAID") + '</button><div class="daybook-actions"><button class="button button--small button--outline" type="button" data-action="edit-record" data-record-type="tuitions" data-id="' + escapeHtml(record.id) + '">EDIT</button><button class="button button--small button--outline" type="button" data-action="delete-record" data-record-type="tuitions" data-id="' + escapeHtml(record.id) + '">DELETE</button></div></div>' +
      '</article>';
  }

  function setList(container, markup, emptyMessage) {
    if (!container) return;
    container.classList.remove("empty-content");
    container.classList.add("daybook-record-list");
    container.innerHTML = markup || emptyMarkup(emptyMessage || "NOTHING HERE YET.");
  }

  function renderTasks() {
    var list = first(['[data-content="planner-list"]', "#tasks-list", ".tasks-list"]);
    if (!list) return;
    var tasks = state.data.tasks.slice().sort(function (a, b) {
      return Number(recordComplete(a)) - Number(recordComplete(b)) || text(a.due).localeCompare(text(b.due));
    });
    setList(list, tasks.map(taskMarkup).join(""), "YOUR NEXT MOVES.");
    var kicker = first([".content-grid--planner .list-panel .panel-kicker span:last-child", ".planner-open-count"]);
    if (kicker) kicker.textContent = tasks.filter(function (item) { return !recordComplete(item); }).length + " OPEN";
  }

  function renderSupportCollections() {
    var dailyList = first(['[data-content="daily-targets-list"]', "#daily-targets-list"]);
    var routinesList = first(['[data-content="routines-list"]', "#routines-list"]);
    var nextList = first(['[data-content="next-day-list"]', '[data-content="next-day-targets-list"]', "#next-day-targets-list"]);
    if (dailyList) setList(dailyList, state.data.dailyTargets.map(dailyTargetMarkup).join(""), "NO DAILY TARGETS.");
    if (routinesList) setList(routinesList, state.data.routines.map(routineMarkup).join(""), "NO ROUTINES YET.");
    if (nextList) setList(nextList, state.data.nextDayTargets.map(nextDayMarkup).join(""), "NO NEXT-DAY TARGETS.");
  }

  function renderTuitions() {
    var list = first(['[data-content="tuition-list"]', "#tuition-list"]);
    if (!list) return;
    var tuitions = state.data.tuitions.slice().sort(function (a, b) {
      return Number(tuitionPaid(a)) - Number(tuitionPaid(b)) || text(a.name).localeCompare(text(b.name));
    });
    setList(list, tuitions.map(tuitionMarkup).join(""), "NO TUITIONS ADDED YET.");
  }

  function expenseDateKey(record) {
    return zonedDateKey(record && record.date) || todayIso();
  }

  function expensesForMonth(monthKey) {
    var month = validMonthKey(monthKey) ? monthKey : monthKeyFor(new Date());
    return state.data.expenses.filter(function (record) { return expenseDateKey(record).slice(0, 7) === month; });
  }

  function ensureSpendingSelection(monthKey) {
    var month = validMonthKey(monthKey) ? monthKey : monthKeyFor(new Date());
    var today = todayIso();
    var selected = dateOnly(state.spendingSelectedDate);
    if (!selected || selected.slice(0, 7) !== month) selected = month === today.slice(0, 7) ? today : month + "-01";
    var day = Number(selected.slice(8, 10));
    if (!day || day > daysInMonth(month)) selected = month + "-" + String(Math.min(Math.max(day || 1, 1), daysInMonth(month))).padStart(2, "0");
    state.spendingMonth = month;
    state.spendingSelectedDate = selected;
    return selected;
  }

  function renderSpendingCalendar(monthKey, records) {
    var month = validMonthKey(monthKey) ? monthKey : monthKeyFor(new Date());
    var selected = ensureSpendingSelection(month);
    var calendar = qs("#spending-calendar-grid");
    var label = qs("#spending-month-label");
    var selectedLabel = qs("#spending-selected-day-label");
    var dayTotal = qs("#spending-selected-day-total");
    var dayCount = qs("#spending-selected-day-count");
    if (label) label.textContent = monthLabel(month);
    if (selectedLabel) selectedLabel.textContent = formatDate(selected, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).toUpperCase();
    var selectedRecords = records.filter(function (record) { return expenseDateKey(record) === selected; });
    if (dayTotal) dayTotal.textContent = formatMoney(selectedRecords.reduce(function (sum, record) { return sum + safeNumber(record.amount); }, 0));
    if (dayCount) {
      dayCount.textContent = String(selectedRecords.length);
      dayCount.setAttribute("aria-label", selectedRecords.length + (selectedRecords.length === 1 ? " entry" : " entries"));
    }
    if (!calendar) return;
    var parts = month.split("-").map(Number);
    var firstDay = new Date(Date.UTC(parts[0], parts[1] - 1, 1)).getUTCDay();
    var totalDays = daysInMonth(month);
    var html = [];
    for (var blank = 0; blank < firstDay; blank += 1) html.push('<span class="spending-calendar__day spending-calendar__day--empty" aria-hidden="true"></span>');
    for (var day = 1; day <= totalDays; day += 1) {
      var dateKey = month + "-" + String(day).padStart(2, "0");
      var dayRecords = records.filter(function (record) { return expenseDateKey(record) === dateKey; });
      var total = dayRecords.reduce(function (sum, record) { return sum + safeNumber(record.amount); }, 0);
       html.push('<button class="spending-calendar__day ' + (dateKey === selected ? "is-selected " : "") + (dayRecords.length ? "spending-calendar__day--has-spend" : "") + '" type="button" data-action="spending-select-day" data-spending-date="' + dateKey + '" aria-label="Select ' + escapeHtml(formatDate(dateKey, { month: "long", day: "numeric", year: "numeric" })) + '" aria-pressed="' + (dateKey === selected ? "true" : "false") + '"><span>' + day + '</span>' + (dayRecords.length ? '<small>' + escapeHtml(formatMoney(total)) + '</small>' : '<small aria-hidden="true">&nbsp;</small>') + '</button>');
    }
    calendar.innerHTML = html.join("");
    calendar.setAttribute("data-month", month);
  }

  function renderExpenses() {
    var list = first(['[data-content="spending-list"]', "#expenses-list", ".spending-list .ledger-list"]);
    ensureSpendingSelection(validMonthKey(state.spendingMonth) ? state.spendingMonth : monthKeyFor(new Date()));
    var month = state.spendingMonth;
    var monthExpenses = expensesForMonth(month).slice().sort(function (a, b) {
      return expenseDateKey(b).localeCompare(expenseDateKey(a)) || text(b.updatedAt).localeCompare(text(a.updatedAt));
    });
    if (list) {
      list.innerHTML = monthExpenses.length ? monthExpenses.map(function (record) {
        return '<li class="ledger-list__item daybook-expense" data-record-id="' + escapeHtml(record.id) + '" data-record-type="expenses"><span class="ledger-date">' + escapeHtml(formatDate(record.date, { month: "short", day: "numeric" }).toUpperCase()) + '</span><strong>' + escapeHtml(record.label) + '</strong><span class="ledger-category">' + escapeHtml(text(record.category).toUpperCase()) + '</span><b>' + formatMoney(record.amount) + '</b><span class="daybook-actions"><button class="button button--small button--outline" type="button" data-action="edit-record" data-record-type="expenses" data-id="' + escapeHtml(record.id) + '">EDIT</button><button class="button button--small button--outline" type="button" data-action="delete-record" data-record-type="expenses" data-id="' + escapeHtml(record.id) + '">DELETE</button></span></li>';
      }).join("") : '<li class="daybook-empty">NO EXPENSES LOGGED FOR ' + escapeHtml(monthLabel(month)) + '.</li>';
    }
    var monthTotal = monthExpenses.reduce(function (sum, item) { return sum + safeNumber(item.amount); }, 0);
    var today = todayIso();
    var weekTotal = state.data.expenses.filter(function (item) { return isWithinRecentDays(item.date, today, 7); }).reduce(function (sum, item) { return sum + safeNumber(item.amount); }, 0);
    var budgetValue = first([".budget-value", "[data-stat=\"spending\"]"]);
    if (budgetValue) budgetValue.textContent = formatMoney(monthTotal);
    var budgetBar = first([".budget-bar i", "[data-progress=\"spending\"]"]);
    if (budgetBar) budgetBar.style.width = Math.min(100, monthTotal ? Math.round((monthTotal / 500) * 100) : 0) + "%";
    var budgetKicker = first([".budget-panel .panel-kicker span:last-child"]);
    if (budgetKicker) budgetKicker.textContent = Math.min(100, monthTotal ? Math.round((monthTotal / 500) * 100) : 0) + "% USED";
    var budgetTitle = first([".budget-panel .panel-kicker span:first-child"]);
    if (budgetTitle) budgetTitle.textContent = monthLabel(month) + " LIMIT";
    var budgetMeta = qsa(".budget-meta span");
    if (budgetMeta[0]) budgetMeta[0].textContent = formatMoney(monthTotal) + " " + monthLabel(month);
    if (budgetMeta[1]) budgetMeta[1].textContent = formatMoney(Math.max(0, 500 - monthTotal)) + " LEFT";
    var spendStat = first(["[data-stat=\"weekly-spend\"]", "[data-stat=\"spend\"]"]);
    if (spendStat) spendStat.textContent = formatMoney(weekTotal);
    renderSpendingCalendar(month, monthExpenses);
  }

  function renderNotes() {
    var list = first(['[data-content="notes-list"]', "#notes-list", ".note-stack"]);
    if (!list) return;
    var notes = state.data.notes.slice().sort(function (a, b) { return text(b.updatedAt).localeCompare(text(a.updatedAt)); });
    list.innerHTML = notes.length ? notes.map(function (record, index) {
      return '<article class="note-card ' + (index % 3 === 0 ? "note-card--blue" : "") + ' daybook-note" data-record-id="' + escapeHtml(record.id) + '" data-record-type="notes"><span class="note-card__date">' + escapeHtml(formatDate(record.updatedAt || record.createdAt, { month: "short", day: "numeric" }).toUpperCase()) + '</span><h2>' + escapeHtml(record.title) + '</h2><p>' + escapeHtml(record.content) + '</p>' + (record.tag ? '<span class="note-card__tag">' + escapeHtml(record.tag).toUpperCase() + '</span>' : '') + '<span class="daybook-actions"><button class="button button--small button--outline" type="button" data-action="edit-record" data-record-type="notes" data-id="' + escapeHtml(record.id) + '">EDIT</button><button class="button button--small button--outline" type="button" data-action="delete-record" data-record-type="notes" data-id="' + escapeHtml(record.id) + '">DELETE</button></span></article>';
    }).join("") : emptyMarkup("CAPTURE A THOUGHT.");
  }

  function renderLinks() {
    var list = first(['[data-content="links-list"]', "#links-list", ".link-list"]);
    if (!list) return;
    var links = state.data.links.slice().sort(function (a, b) { return text(b.updatedAt).localeCompare(text(a.updatedAt)); });
    list.innerHTML = links.length ? links.map(function (record) {
      return '<div class="link-row daybook-link" data-record-id="' + escapeHtml(record.id) + '" data-record-type="links"><a href="' + escapeHtml(sanitizeUrl(record.url)) + '" target="_blank" rel="noopener noreferrer"><span class="link-row__icon" aria-hidden="true">↗</span><span><strong>' + escapeHtml(record.label) + '</strong><small>' + escapeHtml(text(record.category).toUpperCase()) + " · " + escapeHtml(sanitizeUrl(record.url).replace(/^https?:\/\//, "").split("/")[0].toUpperCase()) + '</small></span><span class="link-row__arrow" aria-hidden="true">→</span></a><span class="daybook-actions"><button class="button button--small button--outline" type="button" data-action="edit-record" data-record-type="links" data-id="' + escapeHtml(record.id) + '">EDIT</button><button class="button button--small button--outline" type="button" data-action="delete-record" data-record-type="links" data-id="' + escapeHtml(record.id) + '">DELETE</button></span></div>';
    }).join("") : emptyMarkup("PIN A REFERENCE.");
  }

  function studyTopicKey(termId, courseCode, topicIndex) {
    return termId + "::" + courseCode + "::" + topicIndex;
  }

  function studyCatalog() {
    var dataset = window.STUDY_DATA;
    if (!dataset || !isObject(dataset)) return null;
    var order = Array.isArray(window.STUDY_TERM_ORDER) ? window.STUDY_TERM_ORDER : Object.keys(dataset);
    return { data: dataset, order: order };
  }

  function calculateStudyProgress() {
    var catalog = studyCatalog();
    var done = 0;
    var total = 0;
    if (catalog) {
      catalog.order.forEach(function (termId) {
        var term = catalog.data[termId];
        if (!term || !Array.isArray(term.courses)) return;
        term.courses.forEach(function (course) {
          (course.topics || []).forEach(function (topic, index) {
            total += 1;
            if (state.data.studyProgress.done[studyTopicKey(termId, course.code, index)]) done += 1;
          });
        });
      });
    } else {
      state.data.syllabusProgress.forEach(function (course) {
        total += safeNumber(course.total, 0);
        done += safeNumber(course.completed, 0);
      });
    }
    return { done: done, total: total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function renderSyllabus() {
    var list = first(['[data-content="syllabus-list"]', "#syllabus-list", ".syllabus-grid"]);
    if (!list) return;
    var catalog = studyCatalog();
    var summary = calculateStudyProgress();
    if (catalog) {
      var html = [];
      catalog.order.forEach(function (termId) {
        var term = catalog.data[termId];
        if (!term || !Array.isArray(term.courses)) return;
        html.push('<section class="daybook-term"><div class="panel-kicker"><span>' + escapeHtml(term.short || termId) + '</span><span>' + escapeHtml(term.label || "TERM") + '</span></div><div class="daybook-course-grid">');
        term.courses.forEach(function (course, courseIndex) {
          var topics = course.topics || [];
          var courseDone = topics.reduce(function (count, topic, topicIndex) {
            return count + (state.data.studyProgress.done[studyTopicKey(termId, course.code, topicIndex)] ? 1 : 0);
          }, 0);
          var percent = topics.length ? Math.round((courseDone / topics.length) * 100) : 0;
          html.push('<article class="panel course-card ' + (courseIndex % 3 === 0 ? "course-card--blue" : "") + '" data-course="' + escapeHtml(course.code) + '"><div class="panel-kicker"><span>' + escapeHtml(course.code) + '</span><span>' + percent + '% COMPLETE</span></div><h2>' + escapeHtml(course.title).replace(/ /g, "<br />") + '</h2><div class="progress-line"><i style="width:' + percent + '%"></i></div><p>' + courseDone + ' / ' + topics.length + ' TOPICS · ' + escapeHtml(text(course.credit || "")) + ' CR</p><details><summary>OPEN TOPIC CHECKLIST</summary><div class="daybook-topic-list">');
          topics.forEach(function (topic, topicIndex) {
            var key = studyTopicKey(termId, course.code, topicIndex);
            var checked = !!state.data.studyProgress.done[key];
            var note = state.data.studyProgress.notes[key + "::note"] || "";
            html.push('<label class="daybook-topic-row ' + (checked ? "is-complete" : "") + '"><input type="checkbox" data-action="toggle-topic" data-study-key="' + escapeHtml(key) + '" ' + (checked ? "checked" : "") + ' /><span>' + escapeHtml(topic) + '</span></label><textarea class="daybook-topic-note" data-study-note="' + escapeHtml(key) + '" rows="2" placeholder="Add a note for this topic…">' + escapeHtml(note) + '</textarea>');
          });
          html.push('</div></details></article>');
        });
        html.push('</div></section>');
      });
      list.classList.remove("syllabus-grid");
      list.classList.add("daybook-syllabus-list");
      list.innerHTML = html.join("");
    } else {
      var records = state.data.syllabusProgress;
      list.innerHTML = records.length ? records.map(function (record) {
        var percent = Math.round(safeNumber(record.progress, 0));
        return '<article class="panel course-card daybook-syllabus-record" data-record-id="' + escapeHtml(record.id) + '" data-record-type="syllabusProgress"><div class="panel-kicker"><span>SUBJECT</span><span>' + percent + '% COMPLETE</span></div><h2>' + escapeHtml(record.subject) + '</h2><div class="progress-line"><i style="width:' + percent + '%"></i></div><p>' + escapeHtml(record.completed) + ' / ' + escapeHtml(record.total) + ' TOPICS</p>' + makeActionButtons("syllabusProgress", record, { toggle: false }) + '</article>';
      }).join("") : emptyMarkup("ADD A COURSE.");
    }

    var progressValue = first(['[data-stat="syllabus"]', '[data-stat="progress"]']);
    if (progressValue) progressValue.textContent = summary.pct + "%";
    var progressBars = qsa('[data-progress="syllabus"], .syllabus-progress-bar i');
    progressBars.forEach(function (bar) { bar.style.width = summary.pct + "%"; });
    var overallPct = first(["#overall-progress", "[data-syllabus-overall]"]);
    if (overallPct) overallPct.textContent = summary.pct + "%";
  }

  function themeStorageKey() {
    return text(config.THEME_STORAGE_KEY || "daybook-theme");
  }

  function readThemePreference() {
    var stored = null;
    var store = storage();
    if (store) {
      try {
        stored = store.getItem(themeStorageKey());
        if (stored && /^\s*["']/.test(stored)) stored = JSON.parse(stored);
      } catch (error) {
        stored = null;
      }
    }
    if (stored === "light" || stored === "dark") return stored;
    if (state.data && state.data.settings) return normalizeTheme(state.data.settings.theme);
    return "light";
  }

  function renderThemeChoices() {
    qsa("[data-theme-choice]").forEach(function (choice) {
      var active = normalizeTheme(choice.dataset.themeChoice || choice.getAttribute("data-theme-choice") || choice.value) === state.theme;
      choice.classList.toggle("is-active", active);
      choice.classList.toggle("is-selected", active);
      choice.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function applyTheme(theme, persistChoice) {
    var next = normalizeTheme(theme);
    state.theme = next;
    if (state.data && state.data.settings) state.data.settings.theme = next;
    document.documentElement.setAttribute("data-theme", next);
    var root = qs("#app-root");
    if (root) root.setAttribute("data-theme", next);
    renderThemeChoices();
    if (persistChoice) {
      var store = storage();
      if (store) {
        try { store.setItem(themeStorageKey(), next); } catch (error) {}
      }
      persist("Theme updated.");
    }
  }

  function setTheme(theme) {
    applyTheme(theme, true);
  }

  function themeChoiceValue(element) {
    return element && (element.dataset.themeChoice || element.getAttribute("data-theme-choice") || element.value);
  }

  function updateStatCard(index, value, foot) {
    var cards = qsa(".overview-grid .stat-card");
    var card = cards[index];
    if (!card) return;
    var valueElement = qs(".stat-card__value", card);
    var footElement = qs(".stat-card__foot", card);
    if (valueElement) valueElement.textContent = value;
    if (footElement && foot) footElement.textContent = foot;
  }

  function setText(selectors, value) {
    var element = first(selectors);
    if (element) element.textContent = text(value);
    return element;
  }

  function dayProgress() {
    var today = todayIso();
    var tasks = state.data.tasks.filter(function (item) { return !item.due || item.due === today; });
    var targets = state.data.dailyTargets.filter(function (item) { return !item.date || item.date === today; });
    var total = tasks.length + targets.length;
    var complete = tasks.filter(recordComplete).length + targets.filter(recordComplete).length;
    return { total: total, complete: complete, pct: total ? Math.round((complete / total) * 100) : 0 };
  }

  function renderDashboard() {
    var progress = dayProgress();
    var study = calculateStudyProgress();
    var openTasks = state.data.tasks.filter(function (item) { return !recordComplete(item); }).length;
    var weeklyExpenses = state.data.expenses.filter(function (item) { return isWithinRecentDays(item.date, todayIso(), 7); }).reduce(function (sum, item) { return sum + safeNumber(item.amount); }, 0);
    var todayLabel = new Date();
    setText(["#today-date"], new Intl.DateTimeFormat("en-US", { timeZone: APP_TIME_ZONE, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(todayLabel).toUpperCase());
    setText(["#clock"], new Intl.DateTimeFormat("en-US", { timeZone: APP_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(todayLabel));
    setText(["[data-stat=\"tasks\"]", "#open-tasks", "#stat-tasks"], String(openTasks).padStart(2, "0"));
    setText(["[data-stat=\"spend\"]", "#weekly-spend", "#stat-spend"], formatMoney(weeklyExpenses));
    setText(["[data-stat=\"notes\"]", "#notes-captured", "#stat-notes"], String(state.data.notes.length).padStart(2, "0"));
    updateStatCard(0, String(openTasks).padStart(2, "0"), "ACTIVE / NEEDS ATTENTION");
    updateStatCard(1, formatMoney(weeklyExpenses), "LAST 7 DAYS / ৳");
    updateStatCard(2, String(state.data.notes.length).padStart(2, "0"), "ALL CAPTURED / LOCAL");

    var heroValue = qs(".hero-signal__value");
    if (heroValue) heroValue.innerHTML = progress.pct + "<span>%</span>";
    var heroBar = qs(".hero-signal__bar i");
    if (heroBar) heroBar.style.width = progress.pct + "%";
    var heroLabel = qs(".hero-signal__label");
    if (heroLabel) heroLabel.textContent = progress.total ? "DAY IN MOTION" : "READY TO BEGIN";
    var firstKicker = qs(".overview-hero .panel-kicker span:first-child");
    if (firstKicker) firstKicker.textContent = state.user ? "GOOD MORNING, " + text(state.user.email || "MEMBER").split("@")[0].toUpperCase() : "GOOD MORNING, GUEST";

    var taskList = qs(".overview-tasks .task-list");
    if (taskList) {
      var upcoming = state.data.tasks.filter(function (item) { return !recordComplete(item); }).slice(0, 4);
      taskList.innerHTML = upcoming.length ? upcoming.map(function (item) {
        return '<li class="task-list__item" data-record-id="' + escapeHtml(item.id) + '" data-record-type="tasks"><button type="button" class="daybook-inline-toggle" data-action="toggle-record" data-record-type="tasks" data-id="' + escapeHtml(item.id) + '" aria-label="Complete ' + escapeHtml(item.title) + '"><span class="check-box" aria-hidden="true"></span></button><span><strong>' + escapeHtml(item.title) + '</strong><small>' + escapeHtml(text(item.project || "PERSONAL").toUpperCase()) + (item.due ? " / " + escapeHtml(formatDate(item.due).toUpperCase()) : "") + '</small></span><span class="task-tag">' + escapeHtml(text(item.priority || "TODAY").toUpperCase()) + '</span></li>';
      }).join("") : '<li class="task-list__item"><span class="check-box" aria-hidden="true"></span><span><strong>YOUR BOARD IS CLEAR.</strong><small>ADD A TASK IN PLANNER.</small></span><span class="task-tag">READY</span></li>';
    }

    var routine = state.data.routines.filter(function (item) { return item.active !== false && !recordComplete(item); })[0];
    var nextTarget = state.data.nextDayTargets.filter(function (item) { return !recordComplete(item); })[0];
    var focusTime = qs(".focus-clock");
    var focusTask = qs(".focus-task");
    var focusFooter = qs(".focus-footer span:last-child");
    if (focusTime) focusTime.textContent = routine && routine.time ? routine.time : (nextTarget ? "NEXT" : "--:--");
    if (focusTask) focusTask.textContent = routine ? routine.title : (nextTarget ? nextTarget.title : "Add a routine or next-day target");
    if (focusFooter) focusFooter.textContent = routine ? text(routine.frequency || "DAILY").toUpperCase() : "KEEP THE NEXT MOVE VISIBLE";

    var progressStats = qsa('[data-stat="syllabus"], [data-stat="progress"]');
    progressStats.forEach(function (element) { element.textContent = study.pct + "%"; });
  }

  function renderSettings() {
    var user = state.user;
    var profileCard = qs(".settings-card");
    if (profileCard) {
      var strong = qs(".settings-card__row strong", profileCard);
      var small = qs(".settings-card__row small", profileCard);
      var avatar = qs(".avatar", profileCard);
      var displayName = user ? text(user.user_metadata && (user.user_metadata.display_name || user.user_metadata.name) || user.email || "MEMBER") : "GUEST MODE";
      if (strong) strong.textContent = displayName;
      if (small) small.textContent = user ? text(user.email) : "Saved locally in this browser";
      if (avatar) avatar.textContent = displayName.charAt(0).toUpperCase();
    }
    qsa("[data-setting]").forEach(function (button) {
      var setting = button.dataset.setting;
      var active = state.data.settings[setting] !== false;
      button.classList.toggle("is-on", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    renderThemeChoices();
  }

  function renderAll() {
    renderTasks();
    renderSupportCollections();
    renderExpenses();
    renderTuitions();
    renderNotes();
    renderLinks();
    renderSyllabus();
    renderSettings();
    renderDashboard();
  }

  function ensureRuntimeStyles() {
    if (qs("#daybook-runtime-styles")) return;
    var style = document.createElement("style");
    style.id = "daybook-runtime-styles";
    style.textContent = [
      ".daybook-record-list{display:grid;gap:10px;width:100%}",
      ".daybook-record{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 0;border-top:1px solid rgba(11,11,11,.22);background:transparent}",
      ".daybook-record.is-complete{opacity:.62;background:transparent}",
      ".daybook-record__main{display:flex;align-items:center;gap:12px;min-width:0}",
      ".daybook-record__main>div{min-width:0}",
      ".daybook-record strong,.daybook-record small{display:block}",
      ".daybook-record strong{font-size:.95rem;overflow-wrap:anywhere}",
      ".daybook-record small{margin-top:5px;color:var(--muted,#6d6b66);font:700 .61rem/1.3 var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}",
      ".daybook-check{display:grid;place-items:center;width:24px;height:24px;border:2px solid var(--ink,#0b0b0b);flex:0 0 24px;font-weight:900}",
      ".daybook-chip{padding:6px 8px;background:var(--electric,#4d67ff);color:#fff;font:700 .59rem/1 var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}",
      ".daybook-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;margin-left:auto}",
      ".daybook-actions .button{min-height:28px;padding:7px 8px;font-size:.55rem}",
      ".daybook-empty{display:grid;gap:8px;padding:24px 0;color:var(--muted,#6d6b66);font:700 .7rem/1.5 var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}",
      ".daybook-empty strong{color:var(--ink,#0b0b0b)}",
      ".daybook-empty small{font-size:.58rem}",
      ".daybook-inline-toggle{padding:0;border:0;background:transparent;color:inherit}",
      ".daybook-note .daybook-actions,.daybook-link .daybook-actions{margin-top:14px}",
      ".daybook-link{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".daybook-link>a{display:flex;align-items:center;gap:12px;min-width:0;flex:1;color:inherit}",
      ".daybook-link>a>span:nth-child(2){min-width:0}",
      ".daybook-link strong,.daybook-link small{display:block;overflow-wrap:anywhere}",
      ".daybook-syllabus-list{display:grid;gap:24px}",
      ".daybook-term{display:grid;gap:12px}",
      ".daybook-course-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:14px}",
      ".daybook-topic-list{display:grid;gap:7px;margin-top:12px}",
      ".daybook-topic-row{display:flex;align-items:flex-start;gap:9px;padding:8px 0;border-bottom:1px solid rgba(11,11,11,.16);font-size:.78rem;line-height:1.35}",
      ".daybook-topic-row input{width:auto;min-height:0;margin-top:2px;accent-color:var(--electric,#4d67ff)}",
      ".daybook-topic-row.is-complete{text-decoration:line-through;opacity:.58}",
      ".daybook-topic-note{width:100%;min-height:50px;margin:0 0 5px;border:1px solid rgba(11,11,11,.3);font-size:.78rem}",
      ".daybook-support-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px;margin-top:18px}",
      ".daybook-support-grid .panel{padding:18px}",
      ".daybook-tuition-grid{display:grid;grid-template-columns:minmax(280px,.8fr) minmax(0,1.2fr);gap:16px;margin-top:18px}",
      ".daybook-tuition-grid .panel{padding:18px}",
      ".daybook-tuition{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:16px 0;border-top:1px solid rgba(11,11,11,.22)}",
      ".daybook-tuition:first-child{border-top:0}",
      ".daybook-tuition.is-paid{opacity:.64}",
      ".daybook-tuition__main{min-width:0;flex:1}",
      ".daybook-tuition__heading{display:flex;align-items:flex-start;gap:12px}",
      ".daybook-tuition__heading strong,.daybook-tuition__heading small{display:block}",
      ".daybook-tuition__heading small{margin-top:5px;color:var(--muted,#6d6b66);font:700 .61rem/1.35 var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase;overflow-wrap:anywhere}",
      ".daybook-tuition__main p{margin:10px 0 0;color:var(--muted,#6d6b66);font-size:.8rem;line-height:1.45;overflow-wrap:anywhere}",
      ".daybook-tuition__side{display:grid;justify-items:end;gap:5px;min-width:180px}",
      ".daybook-tuition__side>strong{font-size:1.05rem}",
      ".daybook-tuition__side>small{color:var(--muted,#6d6b66);font:700 .58rem/1 var(--mono,monospace);letter-spacing:.08em}",
      ".daybook-tuition__side .daybook-actions{margin-left:0}",
      ".daybook-checkbox-field>span:last-child{display:flex;align-items:center;gap:8px;font:800 .68rem/1 var(--mono,monospace);letter-spacing:.06em}",
      ".daybook-checkbox-field input{width:auto;min-height:0;accent-color:var(--electric,#4d67ff)}",
      ".daybook-calendar-panel{display:grid;gap:18px;margin-top:18px;padding:18px}",
      ".daybook-calendar-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}",
      ".daybook-calendar-toolbar .button{min-width:110px}",
      ".daybook-calendar-month{font:900 1.15rem/1 var(--display,Arial,sans-serif);letter-spacing:-.03em}",
      ".daybook-calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}",
      ".daybook-calendar__weekday{padding:6px 4px;color:var(--muted,#6d6b66);font:800 .58rem/1 var(--mono,monospace);letter-spacing:.06em;text-align:center}",
      ".daybook-calendar__blank{min-height:72px}",
      ".daybook-calendar__day{display:grid;min-height:72px;align-content:space-between;gap:8px;padding:8px;border:2px solid var(--ink,#0b0b0b);border-radius:0;background:var(--paper,#f3f2ee);color:var(--ink,#0b0b0b);font:800 .75rem/1 var(--mono,monospace);text-align:left;transition:background-color 130ms ease,color 130ms ease,transform 130ms ease}",
      ".daybook-calendar__day:hover,.daybook-calendar__day.is-selected{background:var(--electric,#4d67ff);color:#fff;transform:translate(-1px,-1px)}",
      ".daybook-calendar__day small{min-height:1em;color:var(--muted,#6d6b66);font:700 .55rem/1 var(--mono,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".daybook-calendar__day:hover small,.daybook-calendar__day.is-selected small{color:rgba(255,255,255,.82)}",
      ".daybook-calendar__day.has-entries{box-shadow:inset 0 -4px 0 var(--electric,#4d67ff)}",
      ".daybook-calendar-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;padding-top:6px;border-top:2px solid var(--ink,#0b0b0b)}",
      ".daybook-calendar-summary>div{display:grid;gap:5px}",
      ".daybook-calendar-summary small{color:var(--muted,#6d6b66);font:800 .57rem/1 var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}",
      ".daybook-calendar-summary strong{font-size:1rem}",
      ".daybook-theme-choices{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}",
      ".daybook-theme-choices [data-theme-choice]{min-height:32px;padding:8px 10px;border:2px solid var(--ink,#0b0b0b);background:var(--white,#fff);color:var(--ink,#0b0b0b);font:800 .57rem/1 var(--mono,monospace);letter-spacing:.07em}",
      ".daybook-theme-choices [data-theme-choice].is-active{background:var(--electric,#4d67ff);color:#fff}",
      ":root[data-theme=dark]{--ink:#f3f2ee;--ink-soft:#d6d4ce;--paper:#121212;--paper-deep:#1d1d1b;--white:#1c1c1b;--muted:#aaa8a1;--line-thin:1px solid rgba(243,242,238,.26);--shadow:8px 8px 0 #000;--shadow-small:5px 5px 0 #000}",
      ":root[data-theme=dark] body{background:var(--paper);color:var(--ink)}",
      ":root[data-theme=dark] .panel{border-color:var(--ink);background:var(--white);color:var(--ink)}",
      ":root[data-theme=dark] .sidebar{background:#0b0b0b;color:#f3f2ee}",
      ":root[data-theme=dark] .panel--black{border-color:#f3f2ee;background:#0b0b0b;color:#f3f2ee}",
      ":root[data-theme=dark] input,:root[data-theme=dark] select,:root[data-theme=dark] textarea{border-color:var(--ink);background:#242422;color:var(--ink)}",
      ":root[data-theme=dark] .daybook-record,:root[data-theme=dark] .daybook-tuition{border-color:rgba(243,242,238,.22)}",
      ":root[data-theme=dark] .daybook-calendar__day{background:#242422}",
      ".daybook-print-sheet{display:none}",
      "@media print{body[data-daybook-printing=true]>*:not(.daybook-print-sheet){display:none!important}body[data-daybook-printing=true] .daybook-print-sheet{display:block!important;position:static!important;color:#000;background:#fff;font:12px/1.45 Arial,sans-serif}body[data-daybook-printing=true] .daybook-print-sheet h1{margin:0 0 6px;font-size:24px}body[data-daybook-printing=true] .daybook-print-sheet table{width:100%;border-collapse:collapse;margin-top:16px}body[data-daybook-printing=true] .daybook-print-sheet th,body[data-daybook-printing=true] .daybook-print-sheet td{padding:6px;border-bottom:1px solid #bbb;text-align:left}body[data-daybook-printing=true] .daybook-print-sheet .daybook-print-total{margin-top:16px;font-weight:700}}",
      ".toast[data-state=error]{background:#a92222;color:#fff}",
      "@media (max-width:760px){.daybook-tuition-grid{grid-template-columns:1fr}.daybook-tuition{flex-direction:column}.daybook-tuition__side{justify-items:start;min-width:0}.daybook-calendar__blank,.daybook-calendar__day{min-height:58px}.daybook-calendar__day{padding:6px}.daybook-calendar__day small{font-size:.48rem}.daybook-calendar-summary{grid-template-columns:1fr 1fr}.daybook-calendar-summary>div:last-child{grid-column:1/-1}}",
      "@media (max-width:700px){.daybook-record{align-items:flex-start;flex-wrap:wrap}.daybook-record .daybook-actions{width:100%;margin-left:36px}.daybook-chip{margin-left:auto}}"
    ].join("");
    document.head.appendChild(style);
  }

  function createAuthModeControl() {
    var form = qs("#auth-form");
    if (!form || qs("#auth-mode-toggle")) return;
    var button = document.createElement("button");
    button.id = "auth-mode-toggle";
    button.type = "button";
    button.className = "button button--outline button--wide";
    button.dataset.action = "auth-mode";
    button.dataset.authMode = "signup";
    button.textContent = "CREATE A NEW ACCOUNT";
    form.parentNode.insertBefore(button, form.nextSibling);
  }

  function createImportControl() {
    var card = qs(".settings-card--accent");
    if (!card || qs("#import-data-input")) return;
    var input = document.createElement("input");
    input.id = "import-data-input";
    input.type = "file";
    input.accept = "application/json,.json";
    input.hidden = true;
    input.dataset.action = "import-file";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "button button--dark";
    button.dataset.action = "import-data";
    button.textContent = "IMPORT DATA ↙";
    card.appendChild(button);
    card.appendChild(input);
  }

  function createSpendingUi() {
    var spending = qs('[data-view-panel="spending"]');
    if (!spending) return;
    var exportLink = qs(".spending-list .panel-kicker a", spending);
    if (exportLink && !exportLink.dataset.action) {
      exportLink.dataset.action = "export-month-pdf";
      exportLink.removeAttribute("href");
    }
    if (qs("#spending-calendar-grid")) return;
    var panel = document.createElement("article");
    panel.id = "daybook-spending-calendar";
    panel.className = "panel panel--shadow spending-calendar-panel";
    panel.innerHTML = '<div class="panel-kicker"><span>MONTHLY CALENDAR</span><span>CALENDAR / 01</span></div>' +
      '<div class="spending-calendar__head"><div><p class="eyebrow">MONTHLY SPEND MAP</p><h2 class="panel-title spending-calendar__title">TRACK THE FLOW.</h2><p id="spending-month-label" class="spending-calendar__month"></p></div><div class="spending-calendar__controls"><button class="spending-calendar__nav" type="button" data-action="spending-prev" aria-label="Show previous month">←</button><button class="button button--outline spending-calendar__export" type="button" data-action="export-month-pdf">EXPORT MONTH PDF ↗</button><button class="spending-calendar__nav" type="button" data-action="spending-next" aria-label="Show next month">→</button></div></div>' +
      '<div class="spending-calendar__weekdays" aria-hidden="true"><span>SUN</span><span>MON</span><span>TUE</span><span>WED</span><span>THU</span><span>FRI</span><span>SAT</span></div>' +
      '<div id="spending-calendar-grid" class="spending-calendar__grid" role="grid" aria-label="Spending calendar"></div>' +
      '<div class="spending-calendar__summary"><div class="spending-calendar__summary-card"><span>SELECTED DAY</span><strong id="spending-selected-day-label"></strong></div><div class="spending-calendar__summary-card"><span>DAY TOTAL</span><strong id="spending-selected-day-total">৳0.00</strong></div><div class="spending-calendar__summary-card"><span>ENTRIES</span><strong id="spending-selected-day-count">0</strong></div></div>';
    var contentGrid = qs(".content-grid--spending", spending);
    if (contentGrid && contentGrid.parentNode) contentGrid.parentNode.insertBefore(panel, contentGrid.nextSibling);
    else spending.appendChild(panel);
  }

  function createTuitionUi() {
    if (qs("#tuition-form") && qs('[data-content="tuition-list"]')) return;
    if (qs("#tuition-form") || qs('[data-content="tuition-list"]')) return;
    var spending = qs('[data-view-panel="spending"]');
    if (!spending) return;
    var section = document.createElement("section");
    section.id = "daybook-tuition-section";
    section.className = "daybook-tuition-grid";
    section.innerHTML = '<article class="panel form-panel"><div class="panel-kicker"><span>NEW TUITION</span><span>ENTRY / 008</span></div><h2 class="panel-title">KEEP IT MOVING.</h2><form id="tuition-form" class="stack-form" data-form="tuition"><label class="field"><span class="field__label">STUDENT NAME</span><input name="name" type="text" placeholder="Who are you teaching?" required /></label><div class="field-row"><label class="field"><span class="field__label">SALARY</span><input name="salary" type="number" min="0" step="0.01" placeholder="0.00" required /></label><label class="field"><span class="field__label">PHONE</span><input name="phone" type="tel" placeholder="01XXXXXXXXX" /></label></div><label class="field"><span class="field__label">ADDRESS</span><input name="address" type="text" placeholder="Where do you meet?" /></label><label class="field"><span class="field__label">SUBJECT</span><input name="subject" type="text" placeholder="Subject or class" /></label><label class="field"><span class="field__label">SUBJECT / NOTES</span><textarea name="notes" rows="4" placeholder="Schedule, reminders, or context"></textarea></label><label class="field daybook-checkbox-field"><span class="field__label">PAYMENT STATE</span><span><input name="paid" type="checkbox" value="true" /> MARK AS PAID</span></label><button class="button button--primary" type="submit">SAVE TUITION <span aria-hidden="true">+</span></button></form></article><article class="panel list-panel"><div class="panel-kicker"><span>TUITION QUEUE</span><span>PAID / OPEN</span></div><div class="daybook-record-list" data-content="tuition-list"></div></article>';
    spending.appendChild(section);
  }

  function createThemeControls() {
    if (qsa("[data-theme-choice]").length) return;
    var settingButton = qs('[data-setting="accent-mode"]');
    var host = settingButton ? (settingButton.closest(".settings-card__row") || settingButton.parentNode) : qs('[data-view-panel="settings"]');
    if (!host) return;
    var choices = document.createElement("div");
    choices.className = "daybook-theme-choices";
    choices.innerHTML = '<button type="button" data-theme-choice="light" aria-pressed="false">LIGHT</button><button type="button" data-theme-choice="dark" aria-pressed="false">DARK</button>';
    host.appendChild(choices);
  }

  function removePlannerSupportPanel() {
    var support = qs("#daybook-planner-support");
    if (support) support.remove();
  }

  function ensureUi() {
    ensureRuntimeStyles();
    removePlannerSupportPanel();
    createSpendingUi();
    createTuitionUi();
    createThemeControls();
    createAuthModeControl();
    createImportControl();
    var root = qs("#app-root");
    if (root) root.dataset.appVersion = text(config.APP_VERSION || "1.0.0");
  }

  function activateView(view) {
    var name = text(view || "overview").replace(/^view-/, "");
    var panel = qs('[data-view-panel="' + name + '"]');
    if (!panel) name = "overview";
    qsa("[data-view]").forEach(function (button) {
      var active = text(button.dataset.view) === name;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    qsa("[data-view-panel]").forEach(function (element) {
      element.hidden = text(element.dataset.viewPanel) !== name;
      element.classList.toggle("view--active", text(element.dataset.viewPanel) === name);
    });
    var root = qs("#app-root");
    if (root) root.dataset.currentView = name;
    state.currentView = name;
    var mobile = qs("#mobile-nav");
    var menuButton = qs("#mobile-menu");
    if (mobile && window.matchMedia && window.matchMedia("(max-width: 900px)").matches) mobile.hidden = true;
    if (menuButton) menuButton.setAttribute("aria-expanded", "false");
    if (root) root.dataset.menuOpen = "false";
  }

  function toggleMobileMenu() {
    var mobile = qs("#mobile-nav");
    var button = qs("#mobile-menu");
    var root = qs("#app-root");
    if (!mobile) return;
    var opening = mobile.hidden;
    mobile.hidden = !opening;
    if (button) button.setAttribute("aria-expanded", opening ? "true" : "false");
    if (root) root.dataset.menuOpen = opening ? "true" : "false";
  }

  function setAuthMode(mode) {
    state.authMode = /sign.?up|create|register/i.test(text(mode)) ? "signup" : "signin";
    var form = qs("#auth-form");
    if (form) form.dataset.authMode = state.authMode;
    var submit = qs('button[type="submit"]', form);
    if (submit) submit.innerHTML = state.authMode === "signup" ? 'CREATE ACCOUNT <span aria-hidden="true">↗</span>' : 'ENTER WORKSPACE <span aria-hidden="true">↗</span>';
    var toggle = qs("#auth-mode-toggle");
    if (toggle) {
      toggle.dataset.authMode = state.authMode === "signup" ? "signin" : "signup";
      toggle.textContent = state.authMode === "signup" ? "BACK TO SIGN IN" : "CREATE A NEW ACCOUNT";
    }
    showAuthMessage(state.cloudReady || hasSupabaseConfig() ? "" : "Cloud auth is not configured. Guest mode is ready.", "info");
  }

  function setBusy(form, busy) {
    if (!form) return;
    form.dataset.busy = busy ? "true" : "false";
    qsa("button, input", form).forEach(function (element) {
      if (element.type !== "email" && element.type !== "password") element.disabled = !!busy;
    });
  }

  function hasSupabaseConfig() {
    var url = text(config.SUPABASE_URL).trim();
    var key = text(config.SUPABASE_ANON_KEY).trim();
    if (!url || !key) return false;
    if (/your[-_ ]|replace|example\.com|supabase_url|anon_key/i.test(url + " " + key)) return false;
    return /^https?:\/\//i.test(url);
  }

  function loadScript(src, timeout) {
    return new Promise(function (resolve, reject) {
      var existing = qs('script[data-daybook-script="' + src + '"]');
      if (existing) {
        if (existing.dataset.loaded === "true") {
          resolve();
          return;
        }
        existing.addEventListener("load", function () { resolve(); }, { once: true });
        existing.addEventListener("error", function () { reject(new Error("Unable to load " + src)); }, { once: true });
        return;
      }
      var script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.daybookScript = src;
      var timer = window.setTimeout(function () {
        script.remove();
        reject(new Error("Timed out loading " + src));
      }, timeout || 6500);
      script.onload = function () {
        window.clearTimeout(timer);
        script.dataset.loaded = "true";
        resolve();
      };
      script.onerror = function () {
        window.clearTimeout(timer);
        script.remove();
        reject(new Error("Unable to load " + src));
      };
      document.head.appendChild(script);
    });
  }

  function loadStudyData() {
    if (studyCatalog()) return Promise.resolve();
    var source = text(config.STUDY_DATA_SRC || "study-data.js");
    return loadScript(source, 4500).catch(function () {
      return undefined;
    });
  }

  function loadSupabaseSdk() {
    if (window.supabase && typeof window.supabase.createClient === "function") return Promise.resolve(window.supabase);
    return loadScript(text(config.SUPABASE_CDN || "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"), 6500).then(function () {
      if (!window.supabase || typeof window.supabase.createClient !== "function") throw new Error("Supabase browser SDK did not expose createClient");
      return window.supabase;
    });
  }

  function attachAuthListener() {
    if (!state.supabase || !state.supabase.auth || typeof state.supabase.auth.onAuthStateChange !== "function") return;
    state.supabase.auth.onAuthStateChange(function (event, session) {
      window.setTimeout(function () {
        if (event === "SIGNED_OUT" || !session) {
          if (state.user && !state.isGuest) {
            state.session = null;
            state.user = null;
            state.isGuest = false;
            showAuth(true);
            setSyncStatus("LOCAL / READY", "local");
          }
        } else if (session && (!state.session || !state.user || state.user.id !== session.user.id)) {
          enterSession(session);
        }
      }, 0);
    });
  }

  function initSupabase() {
    if (!hasSupabaseConfig()) {
      state.cloudError = "Cloud credentials are blank";
      return Promise.resolve(null);
    }
    return loadSupabaseSdk().then(function (sdk) {
      state.supabase = sdk.createClient(text(config.SUPABASE_URL).trim(), text(config.SUPABASE_ANON_KEY).trim(), {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
      state.cloudReady = true;
      attachAuthListener();
      return state.supabase.auth.getSession();
    }).then(function (response) {
      return response && response.data ? response.data.session : null;
    }).catch(function (error) {
      state.cloudReady = false;
      state.cloudError = error && error.message ? error.message : "Cloud unavailable";
      return null;
    });
  }

  function loadRemoteData() {
    if (!state.supabase || !state.user) return Promise.resolve(false);
    setSyncStatus("SYNCING / CLOUD", "syncing");
    return state.supabase.from(SUPABASE_TABLE).select("payload,updated_at").eq("user_id", state.user.id).maybeSingle().then(function (response) {
      if (response.error) throw response.error;
      var remote = response.data;
      var shouldPushLocal = !remote;
      if (remote && remote.payload && isObject(remote.payload)) {
        var remoteUpdated = new Date(remote.updated_at || remote.payload.updatedAt || 0).getTime();
        var localUpdated = new Date(state.data.updatedAt || 0).getTime();
        if (!localUpdated || remoteUpdated >= localUpdated) state.data = normalizeData(remote.payload);
        else shouldPushLocal = true;
        saveLocalData();
        return { loaded: true, shouldPushLocal: shouldPushLocal };
      }
      return { loaded: false, shouldPushLocal: true };
    }).then(function (result) {
      if (result.shouldPushLocal) return syncRemote().then(function () { return result.loaded; });
      setSyncStatus("CLOUD / READY", "cloud");
      return result.loaded;
    }).catch(function (error) {
      state.cloudError = error && error.message ? error.message : "Cloud read failed";
      setSyncStatus("LOCAL / READY", "local");
      return false;
    });
  }

  function syncRemote() {
    if (!state.supabase || !state.user || !state.cloudReady) return Promise.resolve(false);
    setSyncStatus("SYNCING / CLOUD", "syncing");
    return state.supabase.from(SUPABASE_TABLE).upsert({
      user_id: state.user.id,
      payload: clone(state.data),
      updated_at: nowIso()
    }, { onConflict: "user_id" }).then(function (response) {
      if (response.error) throw response.error;
      setSyncStatus("CLOUD / SAVED", "cloud");
      return true;
    }).catch(function (error) {
      state.cloudError = error && error.message ? error.message : "Cloud write failed";
      setSyncStatus("LOCAL / READY", "local");
      return false;
    });
  }

  function enterSession(session) {
    if (!session || !session.user) return Promise.resolve();
    state.session = session;
    state.user = session.user;
    state.isGuest = false;
    state.data = loadLocalData();
    return loadRemoteData().then(function () {
      applyTheme(readThemePreference(), false);
      showApp();
      renderAll();
      showAuthMessage("", "info");
      setSyncStatus("CLOUD / READY", "cloud");
    });
  }

  function enterGuest() {
    state.session = null;
    state.user = null;
    state.isGuest = true;
    state.data = loadLocalData();
    applyTheme(readThemePreference(), false);
    showApp();
    renderAll();
    setSyncStatus("LOCAL / READY", "local");
    showToast("Guest workspace ready. Your data stays in this browser.", "success");
  }

  function authSubmit(form) {
    if (!hasSupabaseConfig()) {
      showAuthMessage("Cloud auth is unavailable because Supabase credentials are blank. Continue as guest to work offline.", "info");
      showToast("Guest mode is ready for offline use.", "info");
      return;
    }
    if (!state.supabase || !state.cloudReady) {
      showAuthMessage("Cloud auth could not load. Check your connection or continue as guest.", "error");
      return;
    }
    var email = text(fieldValue(form, ["email"], "")).trim();
    var password = text(fieldValue(form, ["password"], ""));
    if (!email || !password) {
      showAuthMessage("Enter an email address and password to continue.", "error");
      return;
    }
    setBusy(form, true);
    showAuthMessage(state.authMode === "signup" ? "Creating your workspace…" : "Opening your workspace…", "info");
    var request = state.authMode === "signup"
      ? state.supabase.auth.signUp({ email: email, password: password, options: { data: { display_name: email.split("@")[0] } } })
      : state.supabase.auth.signInWithPassword({ email: email, password: password });
    request.then(function (response) {
      if (response.error) throw response.error;
      if (state.authMode === "signup" && (!response.data || !response.data.session)) {
        showAuthMessage("Account created. Check your email if confirmation is enabled, then sign in.", "success");
        showToast("Check your email to confirm the account.", "success");
      } else if (response.data && response.data.session) {
        return enterSession(response.data.session);
      }
      return null;
    }).catch(function (error) {
      showAuthMessage(error && error.message ? error.message : "Unable to authenticate right now.", "error");
      showToast("Authentication failed. Guest mode remains available.", "error");
    }).finally(function () {
      setBusy(form, false);
    });
  }

  function signOut() {
    var result = state.supabase && state.supabase.auth ? state.supabase.auth.signOut() : Promise.resolve();
    Promise.resolve(result).catch(function () { return null; }).then(function () {
      state.session = null;
      state.user = null;
      state.isGuest = false;
      state.data = loadLocalData();
      applyTheme(readThemePreference(), false);
      showAuth(true);
      showAuthMessage("You are signed out. Guest mode is still available.", "info");
      setSyncStatus("LOCAL / READY", "local");
      showToast("Signed out.", "success");
    });
  }

  function completeRecord(kind, id, field) {
    var record = findRecord(kind, id);
    if (!record) return;
    var toggleField = field || "completed";
    if (collectionFor(kind) === "tuitions" || toggleField === "paid" || toggleField === "ticked") {
      var paid = !tuitionPaid(record);
      record.paid = paid;
      record.ticked = paid;
      record.completed = paid;
      record.status = paid ? "paid" : "unpaid";
    } else if (toggleField === "active") record.active = !safeBoolean(record.active, true);
    else {
      var next = !recordComplete(record);
      record.completed = next;
      record.done = next;
      record.status = next ? "done" : "open";
    }
    record.updatedAt = nowIso();
    persist("Updated.");
  }

  function editRecord(kind, id) {
    var collection = collectionFor(kind);
    var record = findRecord(collection, id);
    var form = findForm(collection);
    if (!record || !form) {
      activateView(collection === "expenses" ? "spending" : collection === "tuitions" ? "tuition" : collection === "notes" ? "notes" : collection === "links" ? "links" : collection === "syllabusProgress" ? "syllabus" : "planner");
      showToast("This record is ready to edit when its form is available.", "info");
      return;
    }
    form.dataset.editingId = record.id;
    qsa("input,select,textarea", form).forEach(function (field) {
      if (!field.name) return;
      var value = firstValue(record, [field.name], "");
      if (field.name === "title" && collection === "expenses") value = record.label;
      if (field.name === "label" && collection === "notes") value = record.title;
      if (collection === "tuitions") {
        var tuitionFieldMap = { student: "name", studentName: "name", title: "name", label: "name", amount: "salary", fee: "salary", monthlySalary: "salary", pay: "salary", mobile: "phone", contact: "phone", telephone: "phone", location: "address", area: "address", course: "subject", class: "subject", topic: "subject", note: "notes", details: "notes", description: "notes", isPaid: "paid", ticked: "paid", completed: "paid", done: "paid" };
        value = record[tuitionFieldMap[field.name] || field.name];
      }
      if (field.type === "checkbox") field.checked = safeBoolean(value);
      else field.value = value == null ? "" : value;
    });
    var submit = qs('button[type="submit"]', form);
    if (submit) {
      var label = collection === "expenses" ? "UPDATE EXPENSE" : collection === "tuitions" ? "UPDATE TUITION" : collection === "notes" ? "UPDATE NOTE" : collection === "links" ? "UPDATE LINK" : "UPDATE RECORD";
      submit.innerHTML = label + ' <span aria-hidden="true">↗</span>';
    }
    var targetView = collection === "expenses" ? "spending" : collection === "tuitions" ? "tuition" : collection === "notes" ? "notes" : collection === "links" ? "links" : collection === "syllabusProgress" ? "syllabus" : "planner";
    activateView(targetView);
    showToast("Editing " + (record.title || record.label || "record") + ". Save the form when ready.", "info");
    var firstInput = qs("input,textarea,select", form);
    if (firstInput && typeof firstInput.focus === "function") firstInput.focus();
  }

  function deleteRecord(kind, id) {
    var collection = collectionFor(kind);
    if (!collection || !Array.isArray(state.data[collection])) return;
    var before = state.data[collection].length;
    state.data[collection] = state.data[collection].filter(function (record) { return text(record.id) !== text(id); });
    if (state.data[collection].length === before) return;
    persist("Record deleted.");
  }

  function submitRecord(form) {
    var collection = formKind(form);
    if (!collection || COLLECTIONS.indexOf(collection) === -1) return;
    var editingId = form.dataset.editingId || "";
    var existing = editingId ? findRecord(collection, editingId) : null;
    var record = formToRecord(form, collection, existing);
    if (!validateRecord(collection, record)) {
      showToast("Add the required details before saving.", "error");
      return;
    }
    if (existing) {
      record.createdAt = existing.createdAt || record.createdAt;
      record.updatedAt = nowIso();
      state.data[collection] = state.data[collection].map(function (item) { return item.id === existing.id ? record : item; });
      showToast("Updated in your Daybook.", "success");
    } else {
      record.createdAt = nowIso();
      record.updatedAt = record.createdAt;
      state.data[collection].unshift(record);
      showToast("Saved to your Daybook.", "success");
    }
    delete form.dataset.editingId;
    form.reset();
    var submit = qs('button[type="submit"]', form);
    if (submit) {
       var addLabel = collection === "tasks" ? "ADD TASK" : collection === "dailyTargets" ? "SAVE TARGET" : collection === "routines" ? "SAVE ROUTINE" : collection === "expenses" ? "LOG EXPENSE" : collection === "tuitions" ? "SAVE TUITION" : collection === "notes" ? "SAVE NOTE" : collection === "links" ? "SAVE LINK" : collection === "nextDayTargets" ? "SAVE FOR TOMORROW" : "SAVE RECORD";
      submit.innerHTML = addLabel + ' <span aria-hidden="true">+</span>';
    }
    persist();
  }

  function downloadJson(filename, payload) {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function exportData() {
    var payload = {
      app: text(config.APP_NAME || "DAYBOOK"),
      version: Number(config.STORAGE_VERSION || 1),
      exportedAt: nowIso(),
      data: clone(state.data)
    };
    downloadJson("daybook-export-" + todayIso() + ".json", payload);
    showToast("A portable Daybook export is ready.", "success");
    return payload;
  }

  function jsPdfConstructor() {
    if (window.jspdf && typeof window.jspdf.jsPDF === "function") return window.jspdf.jsPDF;
    if (window.jsPDF && typeof window.jsPDF === "function") return window.jsPDF;
    if (window.jsPDF && typeof window.jsPDF.jsPDF === "function") return window.jsPDF.jsPDF;
    return null;
  }

  function pdfSafeText(value) {
    return text(value).replace(/[^\x20-\x7E]/g, "?");
  }

  function monthReportMarkup(month, records) {
    var total = records.reduce(function (sum, record) { return sum + safeNumber(record.amount); }, 0);
    var rows = records.map(function (record) {
      return '<tr><td>' + escapeHtml(formatDate(record.date, { month: "short", day: "numeric", year: "numeric" })) + '</td><td>' + escapeHtml(record.label) + '</td><td>' + escapeHtml(text(record.category).toUpperCase()) + '</td><td>' + escapeHtml(formatMoney(record.amount)) + '</td></tr>';
    }).join("");
    return '<div class="daybook-print-sheet"><h1>DAYBOOK / SPENDING</h1><div>' + escapeHtml(monthLabel(month)) + '</div><table><thead><tr><th>DATE</th><th>DESCRIPTION</th><th>CATEGORY</th><th>AMOUNT</th></tr></thead><tbody>' + (rows || '<tr><td colspan="4">NO EXPENSES LOGGED.</td></tr>') + '</tbody></table><div class="daybook-print-total">TOTAL: ' + escapeHtml(formatMoney(total)) + '</div></div>';
  }

  function printMonthFallback(month, records) {
    var markup = monthReportMarkup(month, records);
    var printWindow = null;
    try {
      printWindow = typeof window.open === "function" ? window.open("", "_blank") : null;
    } catch (error) {
      printWindow = null;
    }
    if (printWindow && printWindow.document) {
      var reportBody = markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("</div>"));
      printWindow.document.open();
      printWindow.document.write("<!doctype html><html><head><title>Daybook Spending - " + escapeHtml(monthLabel(month)) + "</title><style>body{font:12px/1.45 Arial,sans-serif;color:#000;background:#fff;padding:32px}h1{margin:0 0 6px;font-size:24px}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{padding:6px;border-bottom:1px solid #bbb;text-align:left}.daybook-print-total{margin-top:16px;font-weight:700}</style></head><body>" + reportBody + "</body></html>");
      printWindow.document.close();
      if (typeof printWindow.focus === "function") printWindow.focus();
      window.setTimeout(function () {
        if (typeof printWindow.print === "function") printWindow.print();
        if (typeof printWindow.close === "function") printWindow.close();
      }, 80);
      showToast("PDF library unavailable. A print dialog is ready for this month.", "info");
      return true;
    }
    var sheet = document.createElement("div");
    sheet.innerHTML = markup;
    document.body.appendChild(sheet.firstChild);
    document.body.dataset.daybookPrinting = "true";
    window.setTimeout(function () {
      try {
        if (typeof window.print === "function") window.print();
      } finally {
        document.body.removeAttribute("data-daybook-printing");
        var current = qs(".daybook-print-sheet");
        if (current) current.remove();
      }
    }, 80);
    showToast("PDF library unavailable. Use the print dialog to save this month as PDF.", "info");
    return true;
  }

  function exportMonthPdf() {
    ensureSpendingSelection(validMonthKey(state.spendingMonth) ? state.spendingMonth : monthKeyFor(new Date()));
    var month = state.spendingMonth;
    var records = expensesForMonth(month).slice().sort(function (a, b) { return expenseDateKey(a).localeCompare(expenseDateKey(b)); });
    var Constructor = jsPdfConstructor();
    var load = Constructor ? Promise.resolve() : loadScript(text(config.JSPDF_CDN || "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"), 7500);
    showToast("Preparing " + monthLabel(month) + " spending export…", "info");
    return load.then(function () {
      var Pdf = Constructor || jsPdfConstructor();
      if (!Pdf) throw new Error("jsPDF did not load");
      var doc = new Pdf({ unit: "pt", format: "a4" });
      var total = records.reduce(function (sum, record) { return sum + safeNumber(record.amount); }, 0);
      var y = 44;
      doc.setFontSize(18);
      doc.text("DAYBOOK / SPENDING", 40, y);
      y += 22;
      doc.setFontSize(11);
      doc.text(pdfSafeText(monthLabel(month)), 40, y);
      y += 28;
      doc.setFontSize(9);
      doc.text("DATE", 40, y);
      doc.text("DESCRIPTION", 112, y);
      doc.text("CATEGORY", 350, y);
      doc.text("AMOUNT", 490, y);
      y += 14;
      doc.line(40, y, 555, y);
      y += 16;
      records.forEach(function (record) {
        if (y > 770) {
          doc.addPage();
          y = 44;
        }
        doc.text(pdfSafeText(formatDate(record.date, { month: "short", day: "numeric", year: "numeric" })), 40, y);
        doc.text(pdfSafeText(record.label).slice(0, 42), 112, y);
        doc.text(pdfSafeText(text(record.category).toUpperCase()).slice(0, 18), 350, y);
        doc.text(pdfSafeText(formatMoney(record.amount)), 490, y);
        y += 16;
      });
      if (y > 760) {
        doc.addPage();
        y = 44;
      }
      doc.line(40, y, 555, y);
      y += 20;
      doc.setFontSize(11);
      doc.text("TOTAL: " + pdfSafeText(formatMoney(total)), 40, y);
      doc.save("daybook-spending-" + month + ".pdf");
      showToast("Spending PDF downloaded for " + monthLabel(month) + ".", "success");
      return true;
    }).catch(function () {
      return printMonthFallback(month, records);
    });
  }

  function importData(payload, options) {
    var incoming = payload && payload.data && isObject(payload.data) ? payload.data : payload;
    if (!incoming || !isObject(incoming)) throw new Error("The selected file is not a Daybook JSON export.");
    var replacement = normalizeData(incoming);
    if (options && options.merge) {
      var merged = normalizeData(state.data);
      COLLECTIONS.forEach(function (collection) {
        var existingIds = {};
        merged[collection].forEach(function (item) { existingIds[item.id] = true; });
        replacement[collection].forEach(function (item) {
          if (!existingIds[item.id]) merged[collection].push(item);
        });
      });
      merged.studyProgress.done = Object.assign({}, merged.studyProgress.done, replacement.studyProgress.done);
      merged.studyProgress.notes = Object.assign({}, merged.studyProgress.notes, replacement.studyProgress.notes);
      state.data = merged;
    } else {
      state.data = replacement;
    }
    applyTheme(readThemePreference(), false);
    persist("Import complete.");
    return state.data;
  }

  function importFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        importData(JSON.parse(reader.result));
      } catch (error) {
        showToast(error && error.message ? error.message : "Unable to import that file.", "error");
      }
    };
    reader.onerror = function () { showToast("Unable to read that file.", "error"); };
    reader.readAsText(file);
  }

  function handleStudyTopicToggle(input) {
    var key = input.dataset.studyKey;
    if (!key) return;
    if (input.checked) state.data.studyProgress.done[key] = true;
    else delete state.data.studyProgress.done[key];
    persist("Syllabus progress updated.");
  }

  function handleStudyNote(input) {
    var key = input.dataset.studyNote;
    if (!key) return;
    if (state.noteTimers[key]) window.clearTimeout(state.noteTimers[key]);
    state.noteTimers[key] = window.setTimeout(function () {
      if (input.value.trim()) state.data.studyProgress.notes[key + "::note"] = input.value;
      else delete state.data.studyProgress.notes[key + "::note"];
      persist("Topic note saved.");
    }, 400);
  }

  function handleSetting(button) {
    var setting = button.dataset.setting;
    if (!setting) return;
    state.data.settings[setting] = state.data.settings[setting] === false;
    persist("Setting updated.");
  }

  function changeSpendingMonth(amount) {
    ensureSpendingSelection(validMonthKey(state.spendingMonth) ? state.spendingMonth : monthKeyFor(new Date()));
    state.spendingMonth = shiftMonth(state.spendingMonth, amount);
    state.spendingSelectedDate = "";
    renderExpenses();
  }

  function handleClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest("#mobile-menu")) {
      event.preventDefault();
      toggleMobileMenu();
      return;
    }
    var themeChoice = target.closest("[data-theme-choice]");
    if (themeChoice) {
      event.preventDefault();
      setTheme(themeChoiceValue(themeChoice));
      return;
    }
    var viewLink = target.closest("[data-view]");
    if (viewLink && viewLink.dataset.view) {
      event.preventDefault();
      activateView(viewLink.dataset.view);
      return;
    }
    var actionElement = target.closest("[data-action]");
    if (actionElement) {
      var action = actionElement.dataset.action;
      if (action === "toggle-topic") {
        // Let the checkbox perform its native toggle; the delegated change
        // handler persists the compatible study-tracker key afterward.
        return;
      }
      if (action === "guest-mode" || action === "guest" || actionElement.id === "guest-mode") {
        event.preventDefault();
        enterGuest();
        return;
      }
      if (action === "auth-mode") {
        event.preventDefault();
        setAuthMode(actionElement.dataset.authMode || "signup");
        return;
      }
      if (action === "logout" || action === "signout" || actionElement.id === "logout-btn") {
        event.preventDefault();
        signOut();
        return;
      }
      if (action === "mobile-menu") {
        event.preventDefault();
        toggleMobileMenu();
        return;
      }
      if (action === "spending-prev") {
        event.preventDefault();
        changeSpendingMonth(-1);
        return;
      }
      if (action === "spending-next") {
        event.preventDefault();
        changeSpendingMonth(1);
        return;
      }
      if (action === "spending-select-day") {
        event.preventDefault();
        var selectedDate = dateOnly(actionElement.dataset.spendingDate);
        if (selectedDate && selectedDate.slice(0, 7) === state.spendingMonth) {
          state.spendingSelectedDate = selectedDate;
          renderExpenses();
        }
        return;
      }
      if (action === "export-month-pdf") {
        event.preventDefault();
        exportMonthPdf();
        return;
      }
      if (action === "toggle-record" || action === "toggle" || action.indexOf("toggle-") === 0) {
        event.preventDefault();
        completeRecord(actionElement.dataset.recordType || action.replace(/^toggle-/, ""), actionElement.dataset.id || actionElement.closest("[data-record-id]") && actionElement.closest("[data-record-id]").dataset.recordId, actionElement.dataset.toggleField || (action === "toggle-active" ? "active" : "completed"));
        return;
      }
      if (action === "edit-record" || action === "edit") {
        event.preventDefault();
        editRecord(actionElement.dataset.recordType, actionElement.dataset.id || actionElement.closest("[data-record-id]") && actionElement.closest("[data-record-id]").dataset.recordId);
        return;
      }
      if (action === "delete-record" || action === "delete") {
        event.preventDefault();
        deleteRecord(actionElement.dataset.recordType, actionElement.dataset.id || actionElement.closest("[data-record-id]") && actionElement.closest("[data-record-id]").dataset.recordId);
        return;
      }
      if (action === "export-data") {
        event.preventDefault();
        exportData();
        return;
      }
      if (action === "import-data") {
        event.preventDefault();
        var input = qs("#import-data-input");
        if (input) input.click();
        return;
      }
      if (action === "dismiss-toast") {
        var toast = qs("#toast");
        if (toast) toast.hidden = true;
        return;
      }
      if (action === "edit-profile") {
        showToast("Profile details are managed by your sign-in provider.", "info");
        return;
      }
    }
    var settingElement = target.closest("[data-setting]");
    if (settingElement) {
      event.preventDefault();
      handleSetting(settingElement);
      return;
    }
    if (target.closest("#guest-mode")) {
      event.preventDefault();
      enterGuest();
    }
    if (target.closest("#logout-btn")) {
      event.preventDefault();
      signOut();
    }
    if (target.closest(".toast__close")) {
      var toastElement = qs("#toast");
      if (toastElement) toastElement.hidden = true;
    }
  }

  function handleChange(event) {
    var target = event.target;
    if (!target) return;
    if (target.matches && target.matches("[data-theme-choice]")) {
      setTheme(themeChoiceValue(target));
      return;
    }
    if (target.dataset && target.dataset.studyKey) {
      handleStudyTopicToggle(target);
      return;
    }
    if (target.id === "import-data-input" && target.files && target.files[0]) {
      importFile(target.files[0]);
      target.value = "";
    }
  }

  function handleInput(event) {
    var target = event.target;
    if (target && target.dataset && target.dataset.studyNote) handleStudyNote(target);
  }

  function handleSubmit(event) {
    var form = event.target;
    if (!form || form.tagName !== "FORM") return;
    if (form.id === "auth-form") {
      event.preventDefault();
      authSubmit(form);
      return;
    }
    if (form.dataset.form || form.dataset.recordType || form.id.indexOf("-form") >= 0) {
      event.preventDefault();
      submitRecord(form);
    }
  }

  function armHoverAudio() {
    var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    try {
      if (!state.hoverAudioContext) state.hoverAudioContext = new AudioContextCtor();
      state.hoverAudioArmed = true;
      if (state.hoverAudioContext.state === "suspended" && state.hoverAudioContext.resume) {
        var resumeResult = state.hoverAudioContext.resume();
        if (resumeResult && typeof resumeResult.catch === "function") resumeResult.catch(function () {});
      }
    } catch (error) {
      state.hoverAudioContext = null;
    }
  }

  function playHoverSound() {
    if (!state.hoverAudioArmed) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var context = state.hoverAudioContext;
    if (!context || context.state === "closed") return;
    var now = Date.now();
    if (now - state.lastHoverSoundAt < 80) return;
    state.lastHoverSoundAt = now;

    try {
      var oscillator = context.createOscillator();
      var gain = context.createGain();
      var start = context.currentTime;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(520, start);
      oscillator.frequency.exponentialRampToValueAtTime(700, start + 0.045);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.035, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.075);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.08);
    } catch (error) {
      // Audio is decorative; a blocked or unavailable context must not affect the app.
    }
  }

  function handlePointerOver(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var box = target.closest(".app-content .panel, .app-content .daybook-record, .app-content .note-card, .app-content .link-row, .app-content .empty-content");
    if (!box) return;
    if (event.relatedTarget && box.contains(event.relatedTarget)) return;
    playHoverSound();
  }

  function bindEvents() {
    document.addEventListener("click", handleClick);
    document.addEventListener("change", handleChange);
    document.addEventListener("input", handleInput);
    document.addEventListener("submit", handleSubmit);
    document.addEventListener("pointerdown", armHoverAudio, { passive: true });
    document.addEventListener("keydown", armHoverAudio, { passive: true });
    document.addEventListener("pointerover", handlePointerOver, { passive: true });
  }

  function startClock() {
    if (state.clockTimer) window.clearInterval(state.clockTimer);
    state.lastTodayIso = todayIso();
    state.clockTimer = window.setInterval(function () {
      if (!state.booted) return;
      var clock = qs("#clock");
      if (clock) clock.textContent = new Intl.DateTimeFormat("en-US", { timeZone: APP_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
      var currentDay = todayIso();
      if (currentDay !== state.lastTodayIso) {
        var previousDay = state.lastTodayIso;
        var followedToday = state.spendingMonth === monthKeyFor(previousDay) && (!state.spendingSelectedDate || state.spendingSelectedDate === previousDay);
        state.lastTodayIso = currentDay;
        if (followedToday) {
          state.spendingMonth = monthKeyFor(currentDay);
          state.spendingSelectedDate = currentDay;
        }
        renderAll();
      }
    }, 30000);
  }

  function delay(milliseconds) {
    return new Promise(function (resolve) { window.setTimeout(resolve, milliseconds); });
  }

  function init() {
    if (state.booted) return App;
    state.booted = true;
    ensureUi();
    bindEvents();
    state.data = loadLocalData();
    applyTheme(readThemePreference(), false);
    showScreen(qs("#app-root"), false);
    showScreen(qs("#auth-screen"), false);
    showBoot(true);
    setBootStatus("Loading local workspace…", 18);
    setAuthMode("signin");
    startClock();

    Promise.all([
      delay(520),
      loadStudyData().then(function () { setBootStatus("Preparing your study map…", 55); }),
      initSupabase().then(function () { setBootStatus("Checking account access…", 78); })
    ]).then(function (results) {
      var session = results[2];
      renderAll();
      if (session) {
        return enterSession(session);
      }
      state.isGuest = false;
      showAuth(true);
      setSyncStatus("LOCAL / READY", "local");
      if (!hasSupabaseConfig()) showAuthMessage("Cloud auth is not configured. Continue as guest to use this browser offline.", "info");
      else if (state.cloudError) showAuthMessage("Cloud sign-in is unavailable right now. You can continue as a guest.", "info");
      return null;
    }).catch(function () {
      state.isGuest = false;
      renderAll();
      showAuth(true);
      showAuthMessage("Your local workspace is ready. Continue as a guest if cloud access is unavailable.", "info");
    }).then(function () {
      setBootStatus("Workspace ready.", 100);
      window.setTimeout(function () {
        showBoot(false);
      }, 260);
    });
    return App;
  }

  App.init = init;
  App.getData = function () { return clone(state.data); };
  App.save = function (message) { return persist(message || "Saved."); };
  App.showToast = showToast;
  App.activateView = activateView;
  App.enterGuest = enterGuest;
  App.signOut = signOut;
  App.exportData = exportData;
  App.exportMonthPdf = exportMonthPdf;
  App.setTheme = setTheme;
  App.todayIso = todayIso;
  App.importData = importData;
  App.loadLocalData = loadLocalData;
  App.normalizeData = normalizeData;
  App.addRecord = function (kind, values) {
    var collection = collectionFor(kind);
    if (!collection) throw new Error("Unknown Daybook collection: " + kind);
    var record = normalizeRecord(collection, values || {}, state.data[collection].length);
    if (!validateRecord(collection, record)) throw new Error("Required record details are missing.");
    state.data[collection].unshift(record);
    persist("Saved to your Daybook.");
    return clone(record);
  };
  App.updateRecord = function (kind, id, values) {
    var collection = collectionFor(kind);
    var existing = findRecord(collection, id);
    if (!existing) return null;
    var nextValues = Object.assign({}, existing, values || {});
    if (collection === "tuitions" && values) {
      if (values.paid === undefined && values.ticked !== undefined) nextValues.paid = values.ticked;
      if (values.ticked === undefined && values.paid !== undefined) nextValues.ticked = values.paid;
    }
    var record = normalizeRecord(collection, nextValues, 0);
    record.id = existing.id;
    record.createdAt = existing.createdAt;
    record.updatedAt = nowIso();
    state.data[collection] = state.data[collection].map(function (item) { return item.id === existing.id ? record : item; });
    persist("Updated in your Daybook.");
    return clone(record);
  };
  App.deleteRecord = function (kind, id) { deleteRecord(kind, id); };
  App.toggleRecord = function (kind, id, field) { completeRecord(kind, id, field); };

  window.DaybookApp = App;
  window.APP = App;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})(typeof window !== "undefined" ? window : null, typeof document !== "undefined" ? document : null);
