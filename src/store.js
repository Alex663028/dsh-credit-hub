/**
 * Data dir + JSON stores.
 *
 * Same home resolution the harness home-paths helper uses: `$DSH_HOME` else
 * `~/.dsh`. Everything this plugin persists lives under `{home}/credit-hub/`.
 * Credential-bearing files are written 0600 into a 0700 directory, through a
 * temp file + rename, so a reader never sees a half-written store.
 *
 * @module src/store.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

/** Windows 下 Node 的 chmod 只影响只读位，必须显式收紧 ACL。每个文件只做一次，best-effort。 */
const aclDone = new Set()
function tightenWindowsAcl(file) {
  if (process.platform !== 'win32' || aclDone.has(file)) return
  aclDone.add(file)
  try {
    const principal = `${process.env.USERDOMAIN ?? '.'}\\${process.env.USERNAME ?? 'Users'}`
    spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${principal}:(F)`], {
      stdio: 'ignore', timeout: 2000, windowsHide: true,
    })
  } catch {}
}

export const DATA_DIR_NAME = 'credit-hub'

/** `$DSH_HOME` else `~/.dsh` — the shared home every DSH composition agrees on. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

export function dataDirOf(home = dshHome()) {
  return path.join(home, DATA_DIR_NAME)
}

/**
 * One JSON file store. `secret: true` tightens file/dir modes and forces an
 * fsync, because a torn credential file is worse than a lost one.
 */
function jsonStore(file, { secret = false, defaults = null } = {}) {
  const dir = path.dirname(file)
  let cache
  let loaded = false
  const mode = secret ? 0o600 : 0o644
  const dirMode = secret ? 0o700 : 0o755
  const ensureDir = () => fs.mkdirSync(dir, { recursive: true, mode: dirMode })
  const store = {
    get path() { return file },
    load() {
      if (loaded) return cache
      loaded = true
      try {
        cache = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        cache = typeof defaults === 'function' ? defaults() : structuredClone(defaults)
      }
      if (cache === null || typeof cache !== 'object') cache = {}
      return cache
    },
    save() {
      ensureDir()
      const body = JSON.stringify(cache, null, 2)
      const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
      const flag = secret ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC : 'w'
      if (secret) {
        const fd = fs.openSync(temp, flag, mode)
        try {
          fs.writeFileSync(fd, body)
          fs.fsyncSync(fd)
        } finally { fs.closeSync(fd) }
      } else {
        fs.writeFileSync(temp, body)
      }
      fs.renameSync(temp, file)
      try { fs.chmodSync(file, mode) } catch {}
      if (secret) tightenWindowsAcl(file)
      return cache
    },
    update(fn) {
      const next = fn(store.load())
      if (next !== undefined) cache = next
      store.save()
      return cache
    },
    dispose() { loaded = false; cache = undefined },
  }
  return store
}

export function createStores(home = dshHome()) {
  const dir = dataDirOf(home)
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  const settings = jsonStore(path.join(dir, 'settings.json'), { defaults: {} })
  const accounts = jsonStore(path.join(dir, 'accounts.json'), { secret: true, defaults: { workbuddy: [] } })
  const routes = jsonStore(path.join(dir, 'routes.json'), { defaults: { combos: [] } })
  const gatewayDir = path.join(dir, 'gateway')
  return {
    dir,
    home,
    settings,
    accounts,
    routes,
    gatewayDir,
    /** 一次性数据格式迁移：schemaVersion + 清理旧版签到标记（布尔值 / 不带账号后缀）。 */
    migrate() {
      const current = settings.load()
      let changed = false
      if (!Number.isInteger(current.schemaVersion) || current.schemaVersion < 2) {
        current.schemaVersion = 2
        changed = true
      }
      const marks = current.checkinMarks
      if (marks && typeof marks === 'object') {
        for (const [key, value] of Object.entries(marks)) {
          // 旧格式：全局日期键（无 :账号后缀）或布尔值，无法代表某账号已签到
          if (!key.includes(':') || typeof value === 'boolean') {
            delete marks[key]
            changed = true
          }
        }
      }
      if (changed) settings.save()
      return { changed, schemaVersion: 2 }
    },
    dispose() {
      settings.dispose(); accounts.dispose(); routes.dispose()
    },
  }
}

/** 43-char base64url key, same shape the harness gateway keys use. */
export function mintKey() {
  return crypto.randomBytes(32).toString('base64url')
}

/** Constant-time comparison that tolerates missing/short inputs. */
export function keyMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
