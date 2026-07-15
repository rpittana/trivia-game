// iMessage adapter: locates the Messages database inside an iPhone backup,
// lists group chats, and extracts messages for the shared ingest pipeline.
//
// Privacy: only ever copies the backup's sms.db (never modifies the original backup),
// and --list-chats prints names/handles/message counts only — never message text.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const common = require("./common");

const APPLE_EPOCH_OFFSET_SEC = 978307200; // seconds between 1970-01-01 and 2001-01-01 (Apple's reference date)

function findDefaultBackupRoot() {
  const candidates = [
    path.join(os.homedir(), "Apple", "MobileSync", "Backup"),
    path.join(process.env.APPDATA || "", "Apple Computer", "MobileSync", "Backup"),
  ];
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    const entries = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(base, e.name));
    if (entries.length > 0) {
      entries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return entries[0];
    }
  }
  return null;
}

function findManifestFileId(manifestDbPath, domain, relativePath) {
  const db = new Database(manifestDbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT fileID FROM Files WHERE domain = ? AND relativePath = ?").get(domain, relativePath);
    return row ? row.fileID : null;
  } finally {
    db.close();
  }
}

/** Copies one file out of the backup by its Manifest.db-indexed (domain, relativePath). Never writes to the backup. */
function copyBackupFile(backupRoot, domain, relativePath, destFilename) {
  const manifestPath = path.join(backupRoot, "Manifest.db");
  if (!fs.existsSync(manifestPath)) return null;

  let fileId;
  try {
    fileId = findManifestFileId(manifestPath, domain, relativePath);
  } catch {
    return null; // Manifest.db unreadable (likely encrypted) — callers of ensureLocalCopy raise a clear error separately
  }
  if (!fileId) return null;

  const sourcePath = path.join(backupRoot, fileId.slice(0, 2), fileId);
  if (!fs.existsSync(sourcePath)) return null;

  const destPath = path.join(__dirname, "..", "data", destFilename);
  fs.copyFileSync(sourcePath, destPath);
  return destPath;
}

/** Copies sms.db out of the backup into data/sms.db. Never writes to the backup itself. */
function ensureLocalCopy({ backupPathOverride } = {}) {
  const backupRoot = backupPathOverride || findDefaultBackupRoot();

  if (!backupRoot) {
    throw new Error(
      `Couldn't find an iPhone backup automatically. Pass --backup="<path to backup folder>" ` +
        `(the folder containing Manifest.db).`
    );
  }
  if (!fs.existsSync(backupRoot)) {
    throw new Error(`Backup folder not found: ${backupRoot}`);
  }
  const manifestPath = path.join(backupRoot, "Manifest.db");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No Manifest.db in ${backupRoot} — is this a valid iOS backup folder?`);
  }

  let fileId;
  try {
    fileId = findManifestFileId(manifestPath, "HomeDomain", "Library/SMS/sms.db");
  } catch (err) {
    throw new Error(
      `Could not read Manifest.db (${err.message}). If this backup is encrypted, that's why — ` +
        `re-sync with "Encrypt local backup" unchecked (Finder or Apple Devices app) and try again. ` +
        `This tool won't attempt to decrypt an encrypted backup.`
    );
  }
  if (!fileId) {
    throw new Error(`sms.db isn't in this backup's file index — Messages may not have been included when it was made.`);
  }

  const sourcePath = path.join(backupRoot, fileId.slice(0, 2), fileId);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Manifest.db points to ${sourcePath}, but that file doesn't exist.`);
  }

  console.log(`Copying Messages database from backup at ${backupRoot} ...`);
  const destPath = path.join(__dirname, "..", "data", "sms.db");
  fs.copyFileSync(sourcePath, destPath);

  try {
    const testDb = new Database(destPath, { readonly: true });
    testDb.prepare("SELECT count(*) FROM sqlite_master").get();
    testDb.close();
  } catch (err) {
    throw new Error(
      `Copied sms.db but it won't open as a database (${err.message}). This backup is likely encrypted — ` +
        `re-sync with "Encrypt local backup" unchecked and try again.`
    );
  }

  return destPath;
}

function normalizePhone(value) {
  const digits = (value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Best-effort: cross-references handles (phone numbers / emails) against the backup's
 * AddressBook (your saved Contacts) to resolve them to names you already have saved.
 * Never touches message content. Returns a Map<handle, name>; empty if AddressBook
 * isn't present/readable (e.g. contacts weren't included in the backup) — callers
 * should treat that as "no names available", not an error.
 */
function resolveContactNames(handles, { backupPathOverride } = {}) {
  const backupRoot = backupPathOverride || findDefaultBackupRoot();
  if (!backupRoot) return new Map();

  const destPath = copyBackupFile(backupRoot, "HomeDomain", "Library/AddressBook/AddressBook.sqlitedb", "addressbook.db");
  if (!destPath) return new Map();

  let rows;
  try {
    const db = new Database(destPath, { readonly: true });
    rows = db
      .prepare(
        `SELECT p.First as first, p.Last as last, m.value as value
         FROM ABPerson p
         JOIN ABMultiValue m ON m.record_id = p.ROWID
         WHERE m.property IN (3, 4)` // 3 = phone, 4 = email in the classic AddressBook schema
      )
      .all();
    db.close();
  } catch {
    return new Map();
  }

  const byPhone = new Map();
  const byEmail = new Map();
  for (const r of rows) {
    const name = [r.first, r.last].filter(Boolean).join(" ").trim();
    if (!name || !r.value) continue;
    if (r.value.includes("@")) byEmail.set(r.value.toLowerCase(), name);
    else {
      const norm = normalizePhone(r.value);
      if (norm) byPhone.set(norm, name);
    }
  }

  const result = new Map();
  for (const handle of handles) {
    const name = handle.includes("@") ? byEmail.get(handle.toLowerCase()) : byPhone.get(normalizePhone(handle));
    if (name) result.set(handle, name);
  }
  return result;
}

/** Prints one chat's participants with contact names resolved where possible. Names/handles only. */
function showChat(chatId, { backupPathOverride } = {}) {
  const dbPath = ensureLocalCopy({ backupPathOverride });
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare(
      `SELECT c.ROWID as chatId, c.display_name as displayName, c.chat_identifier as chatIdentifier,
              GROUP_CONCAT(DISTINCT h.id) as handles
       FROM chat c
       LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
       LEFT JOIN handle h ON h.ROWID = chj.handle_id
       WHERE c.ROWID = ?
       GROUP BY c.ROWID`
    )
    .get(chatId);
  db.close();

  if (!row) {
    console.log(`No chat with id ${chatId}.`);
    return;
  }

  const handles = (row.handles || "").split(",").filter(Boolean);
  const contactNames = resolveContactNames(handles, { backupPathOverride });

  console.log(`\nChat ${chatId}: "${row.displayName || row.chatIdentifier}"`);
  console.log(`Participants (excluding you — your own messages don't need a handle, just add "me" to your entry):`);
  for (const h of handles) {
    const name = contactNames.get(h);
    console.log(`  ${h}${name ? `  —  ${name}` : ""}`);
  }
  if (contactNames.size === 0) {
    console.log(`\n(No contact names resolved — AddressBook.sqlitedb wasn't in this backup, or none of these are saved contacts.)`);
  }
  console.log(
    `\nAdd each handle to the matching person's "imessageHandles" in data/people.json (and "me" to your own entry).`
  );
}

function listChats({ backupPathOverride } = {}) {
  const dbPath = ensureLocalCopy({ backupPathOverride });
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT c.ROWID as chatId,
              c.display_name as displayName,
              c.chat_identifier as chatIdentifier,
              COUNT(DISTINCT cmj.message_id) as messageCount,
              GROUP_CONCAT(DISTINCT h.id) as handles,
              COUNT(DISTINCT chj.handle_id) as participantCount
       FROM chat c
       LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
       LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
       LEFT JOIN handle h ON h.ROWID = chj.handle_id
       GROUP BY c.ROWID
       HAVING participantCount > 1
       ORDER BY messageCount DESC`
    )
    .all();
  db.close();

  console.log(`\nFound ${rows.length} group chat(s) — names/handles/message counts only, no message content:\n`);
  for (const r of rows) {
    const name = r.displayName || r.chatIdentifier || "(unnamed)";
    console.log(`  chatId ${r.chatId}: "${name}" — ${r.participantCount} participants, ${r.messageCount} messages`);
    console.log(`    handles: ${r.handles}`);
  }
  console.log(`\nPut the right one in data/people.json as a top-level "imessageChatId": <chatId>, then re-run ingest.`);
}

function appleTimeToMs(appleTime) {
  if (!appleTime) return null;
  const isNanoseconds = appleTime > 1e12;
  const seconds = isNanoseconds ? appleTime / 1e9 : appleTime;
  return (seconds + APPLE_EPOCH_OFFSET_SEC) * 1000;
}

/**
 * Best-effort extraction of the NSString payload from a typedstream-encoded
 * attributedBody blob (used when newer iOS leaves message.text empty).
 * Scans for the "NSString" class marker, then tries both length-encodings
 * typedstream uses (a single length byte, or 0x81 + a little-endian uint16)
 * within a small window after it, validated by a printable-character ratio.
 */
function extractTextFromAttributedBody(blob) {
  if (!blob || blob.length === 0) return null;
  const marker = Buffer.from("NSString");
  const idx = blob.indexOf(marker);
  if (idx === -1) return null;

  const scanStart = idx + marker.length;
  const window = Math.min(16, blob.length - scanStart);

  for (let offset = 0; offset < window; offset++) {
    const lenBytePos = scanStart + offset;
    const lenByte = blob[lenBytePos];
    let strStart;
    let length;
    if (lenByte === 0x81 && lenBytePos + 3 <= blob.length) {
      length = blob.readUInt16LE(lenBytePos + 1);
      strStart = lenBytePos + 3;
    } else if (lenByte > 0 && lenByte < 0x80) {
      length = lenByte;
      strStart = lenBytePos + 1;
    } else {
      continue;
    }
    if (length <= 0 || length > 2000 || strStart + length > blob.length) continue;

    const candidate = blob.slice(strStart, strStart + length).toString("utf8");
    const printable = [...candidate].filter((ch) => ch.codePointAt(0) >= 0x20 || ch === "\n").length;
    if (printable / Math.max(1, candidate.length) > 0.8) return candidate;
  }
  return null;
}

function parseTargetGuid(associatedGuid) {
  if (!associatedGuid) return null;
  const slashIdx = associatedGuid.lastIndexOf("/");
  const stripped = slashIdx === -1 ? associatedGuid : associatedGuid.slice(slashIdx + 1);
  return stripped.replace(/^bp:/, "");
}

function findMePersonId(peopleConfig) {
  for (const [handle, personId] of peopleConfig.byImessageHandle) {
    if (handle.toLowerCase() === "me") return personId;
  }
  return null;
}

/**
 * Extracts and filters messages from the configured chat. Shares `dropped`
 * and `seenContent` with the caller so summary stats and dedup are unified
 * across sources. Returns { kept, stream, unresolvedHandles, skippedNoText }.
 */
function extractAndFilter(peopleConfig, { dropped, seenContent }) {
  const dbPath = path.join(__dirname, "..", "data", "sms.db");
  const db = new Database(dbPath, { readonly: true });

  const rows = db
    .prepare(
      `SELECT m.ROWID as rowId, m.guid, m.text, m.attributedBody, m.date, m.is_from_me,
              m.associated_message_type as assocType, m.associated_message_guid as assocGuid,
              h.id as handleId
       FROM chat_message_join cmj
       JOIN message m ON m.ROWID = cmj.message_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE cmj.chat_id = ?
       ORDER BY m.date ASC`
    )
    .all(peopleConfig.imessageChatId);
  db.close();

  const laughByTargetGuid = new Map();
  const otherByTargetGuid = new Map();
  for (const row of rows) {
    if (row.assocType >= 2000 && row.assocType <= 2005) {
      const targetGuid = parseTargetGuid(row.assocGuid);
      if (!targetGuid) continue;
      const map = row.assocType === 2003 ? laughByTargetGuid : otherByTargetGuid;
      map.set(targetGuid, (map.get(targetGuid) || 0) + 1);
    }
  }

  const mePersonId = findMePersonId(peopleConfig);
  const unresolvedHandles = new Map();
  let skippedNoText = 0;
  const kept = [];
  const stream = [];

  for (const row of rows) {
    if (row.assocType >= 2000) continue; // tapbacks and their "removed" 3000-variants are never quotes themselves

    let personId;
    if (row.is_from_me) {
      personId = mePersonId;
    } else if (row.handleId) {
      personId = peopleConfig.byImessageHandle.get(row.handleId) ?? null;
      if (personId == null) unresolvedHandles.set(row.handleId, (unresolvedHandles.get(row.handleId) || 0) + 1);
    } else {
      personId = null;
    }

    let text = row.text && row.text.trim() ? row.text : null;
    if (!text) text = extractTextFromAttributedBody(row.attributedBody);
    if (!text || !text.trim()) {
      skippedNoText++;
      continue;
    }

    const timestampMs = appleTimeToMs(row.date);
    stream.push({ personId, content: text, timestampMs });

    const candidate = common.filterMessage(
      {
        id: `imsg-${row.guid}`,
        personId,
        rawContent: text,
        timestampMs,
        source: "imessage",
        laughReacts: laughByTargetGuid.get(row.guid) || 0,
        otherReacts: otherByTargetGuid.get(row.guid) || 0,
      },
      { nameRegexes: peopleConfig.nameRegexes, seenContent, dropped }
    );
    if (candidate) kept.push(candidate);
  }

  return { kept, stream, unresolvedHandles, skippedNoText };
}

module.exports = {
  listChats,
  showChat,
  resolveContactNames,
  ensureLocalCopy,
  extractAndFilter,
  appleTimeToMs,
  extractTextFromAttributedBody,
};
