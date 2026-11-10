#!/usr/bin/env node
/**
 * Regenerate the reference gateway config kept in the repository (`gateway/litellm-config.yaml`) and the
 * key list beside it (`gateway/.env.example`).
 *
 * The app builds its own copy at install time from the same module, so this file is the reviewable
 * artifact: the diff of a catalogue update is visible in review instead of arriving inside a tarball.
 *
 *   node scripts/build-gateway-config.mjs            # OPENROUTER_KEY_1 assumed present (the shipped key)
 *   node scripts/build-gateway-config.mjs --all      # every provider, keys filled in later
 *   node scripts/build-gateway-config.mjs --check    # exit 1 when the files are out of date
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildGatewayConfig, describeGatewayConfig, freeModelCatalogue } from '../server/gateway-config.mjs';

const root = resolve(import.meta.dirname, '..', '..', '..');
const outDir = join(root, 'gateway');
const configFile = join(outDir, 'litellm-config.yaml');
const envFile = join(outDir, '.env.example');

const all = process.argv.includes('--all');
const check = process.argv.includes('--check');

/** What a fresh install sees: the master key the app writes, and the OpenRouter key it ships. */
const env = { LITELLM_MASTER_KEY: 'Quchennb1', OPENROUTER_KEY_1: 'set' };
const built = buildGatewayConfig(env, { includeAll: all });
const info = describeGatewayConfig(env, { includeAll: all });

const keys = [...new Set((freeModelCatalogue().providers ?? []).map((p) => p.auth?.env).filter(Boolean))].sort();
const envText = [
  '# QuChen 免费网关 · 可用的 key（填了哪个，网关就多那一家的模型）',
  '# 生成自 ' + (freeModelCatalogue().source?.package ?? 'dsh-our-free-model') + ' ' + (freeModelCatalogue().source?.version ?? '?'),
  '# 改完重启网关：改这里 → 网关页「停止」→「启动」，配置会按新的 key 重写。',
  'LITELLM_MASTER_KEY=Quchennb1',
  '',
  ...keys.map((k) => '# ' + k + '='),
  '',
].join('\n');

if (check) {
  const now = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
  if (now !== built.text) {
    console.error('gateway/litellm-config.yaml 与生成器不一致，跑一次 node apps/host/scripts/build-gateway-config.mjs');
    process.exit(1);
  }
  console.log('gateway/litellm-config.yaml 是最新的');
  process.exit(0);
}

writeFileSync(configFile, built.text, 'utf8');
writeFileSync(envFile, envText, 'utf8');
console.log('写出了', configFile);
console.log('  模型名 ' + info.models + ' 个 · provider ' + info.providers + ' 个 · 目录 '
  + info.catalogue + '（' + info.catalogueProviders + ' 个 provider，可填 ' + info.keys + ' 个 key）');
console.log('写出了', envFile);
if (!all) console.log('只写了有 key 的 provider；要看全量：--all');
