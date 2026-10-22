#!/usr/bin/env node
/**
 * Rewrite a wrangler config for a specific deploy target.
 *
 * The committed wrangler.jsonc files describe OpenCut's own production
 * deployment: worker names `opencut-web` / `opencut-api` and the
 * `new.opencut.app` custom domain. A fork deploying into its own Cloudflare
 * account does not own that domain, so `wrangler deploy` would fail while
 * trying to attach it.
 *
 * This script lets a deploy override those two things without editing tracked
 * files by hand. It is driven entirely by environment variables and is a no-op
 * unless one is set:
 *
 *   WORKER_NAME    Worker name to deploy under, e.g. `my-opencut-web`.
 *   WORKER_DOMAIN  Custom domain to attach. Use the literal value `none` to
 *                  drop all routes/custom domains and serve from the account's
 *                  `*.workers.dev` subdomain instead.
 *
 * Usage:
 *   node scripts/apply-deploy-config.mjs apps/web/wrangler.jsonc
 *
 * Intended for CI, where the checkout is ephemeral. Running it locally rewrites
 * the config in place (comments are lost, because the result is written as
 * JSON); restore with `git checkout -- <path>`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Strip `//` and `/* *\/` comments from JSONC, leaving string contents intact.
 * Wrangler configs are JSONC, so they must be cleaned before JSON.parse.
 */
export function stripJsoncComments(text) {
  let out = ''
  let i = 0
  let inString = false
  let inLineComment = false
  let inBlockComment = false

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        out += ch
      }
      i++
      continue
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i += 2
        continue
      }
      i++
      continue
    }

    if (inString) {
      out += ch
      if (ch === '\\') {
        // Preserve the escaped character verbatim.
        if (i + 1 < text.length) {
          out += next
          i += 2
          continue
        }
      } else if (ch === '"') {
        inString = false
      }
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }

    if (ch === '/' && next === '/') {
      inLineComment = true
      i += 2
      continue
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }

    out += ch
    i++
  }

  return out
}

function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('Usage: node scripts/apply-deploy-config.mjs <wrangler.jsonc>')
    process.exit(1)
  }

  const workerName = process.env.WORKER_NAME?.trim() || ''
  const workerDomain = process.env.WORKER_DOMAIN?.trim() || ''

  if (!workerName && !workerDomain) {
    console.log('apply-deploy-config: no WORKER_NAME or WORKER_DOMAIN set, leaving config untouched')
    return
  }

  const path = resolve(target)
  const config = JSON.parse(stripJsoncComments(readFileSync(path, 'utf8')))
  const changes = []

  if (workerName && config.name !== workerName) {
    changes.push(`name: ${config.name} -> ${workerName}`)
    config.name = workerName
  }

  if (workerDomain) {
    if (workerDomain.toLowerCase() === 'none') {
      if (config.routes?.length) {
        changes.push(`routes: ${JSON.stringify(config.routes)} -> [] (workers.dev only)`)
      }
      delete config.routes
      if (config.workers_dev !== true) {
        changes.push('workers_dev: -> true (serve from the account *.workers.dev subdomain)')
      }
      // Opt into the account's *.workers.dev subdomain.
      config.workers_dev = true
    } else {
      const routes = [{ pattern: workerDomain, custom_domain: true }]
      changes.push(`routes: ${JSON.stringify(config.routes ?? [])} -> ${JSON.stringify(routes)}`)
      config.routes = routes
    }
  }

  if (changes.length === 0) {
    console.log(`apply-deploy-config: ${path} already matches the requested target`)
    return
  }

  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`apply-deploy-config: rewrote ${path}`)
  for (const change of changes) console.log(`  - ${change}`)
}

main()
