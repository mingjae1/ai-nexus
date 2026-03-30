const fs = require('fs');

const data = JSON.parse(fs.readFileSync('models_cache.json', 'utf8'));
const allowed = new Set(['low', 'medium', 'high', 'none']);

console.log('| model | reasoning_effort | context_window |');
console.log('|---|---|---|');

for (const model of (data.models || [])) {
  if (model.visibility !== 'list') continue;

  const levels = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
    : [];

  const effortsRaw = levels.map((x) => x && x.effort).filter(Boolean);
  const hasXhigh = effortsRaw.includes('xhigh');

  const seen = new Set();
  let efforts = [];
  for (const effort of effortsRaw) {
    if (!allowed.has(effort)) continue;
    if (seen.has(effort)) continue;
    seen.add(effort);
    efforts.push(effort);
  }

  if (hasXhigh) {
    efforts = efforts.map((e) => (e === 'high' ? 'high+xhigh' : e));
  }

  const reasoningEffort = efforts.join('/');
  const contextWindow = model.context_window ?? '';
  const slug = model.slug ?? '';

  console.log(`| ${slug} | ${reasoningEffort} | ${contextWindow} |`);
}

console.log('');
console.log(`Fetched at: ${data.fetched_at ?? ''}`);
