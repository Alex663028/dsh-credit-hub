/**
 * 发布产物校验（CI 与本地共用）。
 *
 * 检查项：
 *   1. files 字段覆盖所有运行时模块（src/**）
 *   2. src/transforms/*.js 存在且被覆盖
 *   3. files 每个条目在磁盘存在
 *   4. 关键发布文件存在（文档、资源、索引、安装脚本）
 *   5. package.version 出现在 market-index 版本列表
 *   6. 源码不含硬编码密钥形态
 *   7. 源码 import 的 @deepseek-ai/* 都在 peerDependencies/dependencies 声明
 *   8. install.ps1 有备份与 DryRun（防覆盖用户配置）
 *   9. 工程根无运行时数据文件
 *
 * @module test/release-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = rel => path.join(root, rel)
const exists = rel => fs.existsSync(at(rel))

let failures = 0
const bad = message => { console.error(`✗ ${message}`); failures += 1 }
const ok = message => console.log(`  ${message}`)

const pkg = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'))

// ── 1/2. files 覆盖 src 与 transforms ───────────────────────────────────────
const walk = dir => fs.readdirSync(at(dir), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.posix.join(dir, entry.name)) : [path.posix.join(dir, entry.name)])
const runtimeFiles = walk('src').filter(f => f.endsWith('.js'))
const filesField = pkg.files ?? []
if (!filesField.some(f => f === 'src' || f.startsWith('src/'))) bad('package.files 未包含 src/')
ok(`运行时模块 ${runtimeFiles.length} 个 .js`)

const transforms = runtimeFiles.filter(f => f.includes('transforms/'))
if (transforms.length < 3) bad(`src/transforms 模块数异常: ${transforms.length}（期望 ≥3）`)
ok(`协议转换器 ${transforms.length} 个: ${transforms.map(f => path.basename(f)).join(', ')}`)

// ── 3. files 条目存在 ───────────────────────────────────────────────────────
for (const entry of filesField) if (!exists(entry)) bad(`package.files 引用了不存在的路径: ${entry}`)

// ── 4. 关键发布文件 ─────────────────────────────────────────────────────────
const REQUIRED = [
  'README.md', 'CHANGELOG.md', 'LICENSE', 'install.ps1', 'market-index.json', 'cordis.patch.yml',
  'index.js', 'client.js',
  'docs/ARCHITECTURE.md', 'docs/TROUBLESHOOTING.md', 'docs/PROTOCOL-MATRIX.md',
]
for (const file of REQUIRED) if (!exists(file)) bad(`缺发布文件: ${file}`)
ok(`关键发布文件 ${REQUIRED.length} 项已检查`)

// ── 5. 版本与 market-index 同步 ─────────────────────────────────────────────
try {
  const index = JSON.parse(fs.readFileSync(at('market-index.json'), 'utf8'))
  if (index.format !== 1) bad(`market-index.format 必须是 1（实际 ${index.format}）`)
  const plugin = index.plugins.find(row => row.name === pkg.name)
  if (plugin === undefined) bad(`market-index 里没有 ${pkg.name}`)
  else {
    const versions = plugin.versions.map(v => v.version)
    if (!versions.includes(pkg.version)) bad(`package.version ${pkg.version} 不在 market-index 版本 [${versions.join(', ')}]`)
    for (const version of plugin.versions) {
      if (!/^[0-9a-f]{40}$/.test(version.source?.commit ?? '')) bad(`${pkg.name}@${version.version} commit 不是 40 位 hex`)
      if (!Number.isFinite(version.publishTimestamp)) bad(`${pkg.name}@${version.version} publishTimestamp 非法`)
    }
    ok(`market-index 版本 [${versions.join(', ')}] · package ${pkg.version}`)
  }
} catch (error) {
  bad(`market-index.json 读取失败: ${error.message}`)
}

// ── 6. 密钥泄露扫描 ─────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  { name: 'OpenAI 风格 key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: '超长 Bearer', re: /Bearer\s+[A-Za-z0-9_-]{30,}/ },
  { name: '私钥块', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
]
for (const file of [...runtimeFiles, 'index.js', 'client.js']) {
  const text = fs.readFileSync(at(file), 'utf8')
  for (const { name, re } of SECRET_PATTERNS) if (re.test(text)) bad(`${file} 疑似含${name}`)
}
ok('密钥泄露扫描完成')

// ── 7. import 的宿主包都已声明 ──────────────────────────────────────────────
const declared = new Set([
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.dependencies ?? {}),
])
const imported = new Set()
for (const file of [...runtimeFiles, 'index.js']) {
  const text = fs.readFileSync(at(file), 'utf8')
  for (const match of text.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) imported.add(match[1])
  for (const match of text.matchAll(/require\(['"](@deepseek-ai\/[^'"]+)['"]\)/g)) imported.add(match[1])
}
for (const spec of imported) {
  const base = spec.split('/').slice(0, 2).join('/')
  if (!declared.has(base) && !declared.has(spec)) bad(`源码 import 了未声明的依赖: ${spec}`)
}
ok(`宿主包引用 ${imported.size} 个，全部已声明`)

// ── 8. install.ps1 安全（备份 + DryRun）─────────────────────────────────────
if (exists('install.ps1')) {
  const script = fs.readFileSync(at('install.ps1'), 'utf8')
  if (!/bak-|Copy-Item.*\$backup/i.test(script)) bad('install.ps1 缺备份逻辑（会覆盖用户配置）')
  if (!/DryRun/i.test(script)) bad('install.ps1 缺 DryRun 开关')
  ok('install.ps1 含备份 + DryRun')
}

// ── 9. 根目录不得有运行时数据 ───────────────────────────────────────────────
const RUNTIME_DATA = ['accounts.json', 'settings.json', 'usage.json', 'routes.json', 'logs.jsonl']
for (const file of RUNTIME_DATA) {
  if (exists(file)) bad(`工程根出现运行时数据文件: ${file}（应只存在于 {DSH_HOME}/credit-hub/）`)
}
ok('根目录无运行时数据文件')

console.log(failures === 0 ? '\nRELEASE CHECK PASS' : `\n${failures} RELEASE CHECK FAILURES`)
process.exit(failures === 0 ? 0 : 1)