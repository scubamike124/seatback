// Quick end-to-end run on synthetic fixtures. Usage: node scripts/smoke.ts
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { SYNTHETIC_CATALOGUE, EXAMPLE_ROUTES } from '../src/examples.ts';

const ex = EXAMPLE_ROUTES[0]!;
const result = await runPipeline(
  { ...ex.request, catalogue: SYNTHETIC_CATALOGUE },
  {
    qloo: new FixtureQlooClient(),
    llm: null,
    emit: (e) => {
      if (e.type === 'step') console.log(`[${e.status}] ${e.label}${e.detail ? ' - ' + e.detail : ''}`);
      if (e.type === 'decision') console.log(`  decision: ${e.text}`);
      if (e.type === 'needs_confirmation') console.log('needs confirmation', JSON.stringify(e.items));
    },
  },
);
if (result) {
  for (const d of result.domains) {
    console.log(`\n${d.label} (${d.mode}) sep=${d.separationTau?.toFixed(2)}`);
    for (const p of d.picks) console.log(`  ${Math.round(p.fit * 100)} ${p.side.padEnd(11)} ${p.title}`);
  }
  console.log('\nnote:', result.programmerNote.map((n) => n.text).join(' | '));
  console.log('grounding', result.grounding, 'calls', result.metrics);
  console.log('comparison', result.comparison?.provider, result.comparison?.agreement);
}
