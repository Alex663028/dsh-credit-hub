/**
 * 11128 最小触发点二分定位。
 *
 * 读 diag/11128-body-*.json（插件在失败时落下的完整请求体），对 messages 做
 * 二分：保留 system + 前缀若干条，找到"最短的仍会失败"的前缀，再逐条比对，
 * 打印最小失败集合的结构与正文片段。全部经 8330 网关发真实请求。
 *
 * 用法：node tools/bisect-11128.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const diagDir = path.join(home, 'credit-hub', 'diag')
const keyFile = path.join(home, 'credit-hub', 'gateway', 'api-key')
const apiKey = fs.readFileSync(keyFile, 'utf8').trim()
const endpoint = 'http://127.0.0.1:8330/v1/chat/completions'

const files = fs.existsSync(diagDir)
  ? fs.readdirSync(diagDir).filter(name => /^11128-body-.*\.json$/.test(name))
  : []
if (files.length === 0) {
  console.error('没有找到 11128-body-*.json —— 先在对话框里触发一次失败')
  process.exit(1)
}
const file = path.join(diagDir, files.sort().at(-1))
const base = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log(`载荷: ${file}`)
console.log(`消息数: ${base.messages?.length ?? 0} | tools: ${base.tools?.length ?? 0} | max_tokens: ${base.max_tokens} | thinking: ${JSON.stringify(base.thinking)}`)

const send = async body => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (response.ok && !/"error"\s*:/.test(text)) return { ok: true }
  const code = /"code"\s*:\s*(\d+)/.exec(text)?.[1] ?? String(response.status)
  return { ok: false, code, head: text.slice(0, 160) }
}

const probe = async messages => {
  const body = { ...base, messages }
  delete body.stream
  body.stream = false
  body.max_tokens = Math.min(Number(base.max_tokens) || 64, 64)
  return send(body)
}

const system = base.messages?.[0]
const rest = base.messages?.slice(1) ?? []

// 0. 原样（仅缩小 max_tokens）是否仍失败
const full = await probe(base.messages)
console.log(`\n[0] 完整 ${base.messages.length} 条 -> ${full.ok ? 'OK' : 'FAIL ' + full.code}`)

// 1. 前缀二分：找最短的、仍失败的 system + 前 N 条
let lo = 1
let hi = rest.length
let minimalFail = null
if (!full.ok) {
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const result = await probe([system, ...rest.slice(0, mid)])
    console.log(`  前缀 ${mid} 条 -> ${result.ok ? 'OK' : 'FAIL ' + result.code}`)
    if (!result.ok) { minimalFail = mid; hi = mid - 1 } else { lo = mid + 1 }
  }
}

if (minimalFail !== null) {
  const subset = rest.slice(0, minimalFail)
  console.log(`\n最短失败前缀: system + ${minimalFail} 条`)
  const lastIdx = subset.length - 1
  const prev = subset.slice(0, lastIdx)
  const prevResult = await probe([system, ...prev])
  if (prevResult.ok) {
    console.log(`最后一条（索引 ${lastIdx + 1}）是触发点：`)
    console.log(JSON.stringify(subset[lastIdx]).slice(0, 1200))
  } else {
    console.log('最后一条单独移除仍失败 —— 触发点在前面的组合里')
    subset.forEach((message, index) => {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      console.log(`  [${index + 1}] ${message.role} (${text?.length ?? 0} chars): ${String(text).slice(0, 200).replace(/\n/g, ' ')}`)
    })
  }
  // 2. 单个工具/参数维度：去掉 tools、thinking、reasoning_effort 各试一次
  console.log('\n维度排查（在最短失败前缀上）：')
  const prefix = [system, ...subset]
  for (const [label, patch] of [
    ['去掉 tools', { tools: undefined }],
    ['去掉 thinking', { thinking: undefined }],
    ['去掉 reasoning_effort', { reasoning_effort: undefined }],
    ['max_tokens=4096', { max_tokens: 4096 }],
  ]) {
    const body = { ...base, messages: prefix, stream: false, max_tokens: 64, ...patch }
    const result = await send(body)
    console.log(`  ${label} -> ${result.ok ? 'OK（该维度是触发点）' : 'FAIL ' + result.code}`)
  }
} else if (full.ok) {
  console.log('\n完整载荷经网关通过 —— 说明失败与 DSH 侧并发/账号选择有关，而非载荷内容')
}
