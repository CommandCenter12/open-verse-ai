// Imports the MIT-licensed trading skills (method write-ups only) into knowledge/ as
// trading-<skill>.md so the Worker can cite them. Re-run after updating the skills, then
// `node scripts/build-index.mjs`.
//   node scripts/import-trading-skills.mjs [skillsDir]   (default: ~/.claude/skills)
// Only SKILL.md is imported (not scripts or references/) to keep the Worker bundle small.
// Personal skills are never imported: the list below is an explicit allowlist.
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'knowledge');
const srcDir = process.argv[2] || join(homedir(), '.claude', 'skills');

const SOURCES = {
  tradermonty: { repo: 'https://github.com/tradermonty/claude-trading-skills', holder: 'TraderMonty' },
  jake: { repo: 'https://github.com/Jakeschincariol/trader-skill', holder: 'Jake Schincariol' },
};
const TRADERMONTY = [
  'backtest-expert',
  'breadth-chart-analyst',
  'breakout-trade-planner',
  'canslim-screener',
  'contrarian-setup-gate',
  'cot-contrarian-detector',
  'crypto-regime-analyzer',
  'data-quality-checker',
  'dividend-growth-pullback-screener',
  'downtrend-duration-analyzer',
  'drawdown-circuit-breaker',
  'earnings-calendar',
  'earnings-trade-analyzer',
  'economic-calendar-fetcher',
  'edge-candidate-agent',
  'edge-concept-synthesizer',
  'edge-hint-extractor',
  'edge-pipeline-orchestrator',
  'edge-signal-aggregator',
  'edge-strategy-designer',
  'edge-strategy-reviewer',
  'exposure-coach',
  'finviz-screener',
  'ftd-detector',
  'futures-position-sizer',
  'fxmacrodata-calendar',
  'ibd-distribution-day-monitor',
  'institutional-flow-tracker',
  'kanchi-dividend-review-monitor',
  'kanchi-dividend-sop',
  'kanchi-dividend-us-tax-accounting',
  'macro-regime-detector',
  'manifoldbt-backtester',
  'market-breadth-analyzer',
  'market-environment-analysis',
  'market-news-analyst',
  'market-top-detector',
  'mt5-robot-tester',
  'news-reaction-failure-analyzer',
  'options-strategy-advisor',
  'pair-trade-screener',
  'parabolic-short-trade-planner',
  'pead-screener',
  'portfolio-manager',
  'position-sizer',
  'pre-trade-discipline-gate',
  'residual-edge-analyzer',
  'scenario-analyzer',
  'sector-analyst',
  'signal-postmortem',
  'stanley-druckenmiller-investment',
  'stockbee-20pct-study',
  'stockbee-episodic-pivot-analyzer',
  'stockbee-exhaustion-hammer-screener',
  'stockbee-momentum-burst-screener',
  'stockbee-setup-fluency-trainer',
  'strategy-pivot-designer',
  'technical-analyst',
  'theme-detector',
  'trade-hypothesis-ideator',
  'trade-performance-coach',
  'trader-memory-core',
  'trading-skills-navigator',
  'uptrend-analyzer',
  'us-market-bubble-detector',
  'us-stock-analysis',
  'us-undervalued-growth-screener',
  'value-dividend-screener',
  'vcp-screener',
  'weekly-performance-digest',
];
const JAKE = [
  'trader-alerts',
  'trader-analyst',
  'trader-broker',
  'trader-budget',
  'trader-copycat',
  'trader-news',
  'trader-pelosi',
  'trader-rebalance',
  'trader-risk',
  'trader-screener',
  'trader-tax',
];

const PRIVATE = /mohammad|nassereddin|boukeil|@gmail\.com|MathHw1|CommandCenter12|\b8871\b/i;

function split(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: '', body: src };
  return { fm: m[1], body: src.slice(m[0].length) };
}
function description(fm) {
  const lines = fm.split('\n'); const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return '';
  let first = lines[i].replace(/^description:\s*/, '').trim();
  const out = [];
  if (first && !/^[>|]-?$/.test(first)) out.push(first);
  for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) out.push(lines[j].trim());
  return out.join(' ').replace(/^["']|["']$/g, '').trim();
}
const pretty = (s) => s.split('-').map((w) => (w.length <= 3 && /^(us|ftd|cot|pead|vcp|ibd|mt5|fx)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');

// Remove files from a previous import so renamed/removed skills don't linger.
for (const f of await readdir(outDir)) if (f.startsWith('trading-') && f.endsWith('.md')) await unlink(join(outDir, f));

let n = 0;
for (const [key, list] of [['tradermonty', TRADERMONTY], ['jake', JAKE]]) {
  const s = SOURCES[key];
  for (const name of list) {
    const p = join(srcDir, name, 'SKILL.md');
    if (!existsSync(p)) { console.warn(`skip ${name}: no SKILL.md`); continue; }
    const raw = await readFile(p, 'utf8');
    if (PRIVATE.test(raw)) { console.warn(`skip ${name}: looks personal`); continue; }
    const { fm, body } = split(raw);
    const title = `${pretty(name)} (trading skill)`;
    const text = body.replace(/^# .+\n+/, ''); // the file supplies its own H1
    const md = `---\ntitle: ${title}\ndomain: trading\ndisclaimer: Educational method description from an open-source MIT-licensed skill (${s.holder}). Not investment advice; it does not know your account.\n---\n` +
      `# ${title}\n\nSource: [${s.repo}](${s.repo}) (MIT, © 2026 ${s.holder}), skill \`${name}\`.\n\n## What ${pretty(name)} does\n\n${description(fm)}\n\n${text.trim()}\n`;
    await writeFile(join(outDir, `trading-${name}.md`), md);
    n++;
  }
}
console.log(`imported ${n} trading skills into knowledge/`);
