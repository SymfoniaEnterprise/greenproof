/**
 * ACCEPT - jedyna droga do repo testów: PR z brancha case'a do gałęzi
 * docelowej. Przy okazji podbija liczniki reuse w indeksie POM (telemetria
 * wartości harvestu) i promuje propozycje wiedzy zostawione na branchu.
 */
import type { GreenproofConfig } from '../config/types.js';
import type { MutationProof } from '../domain/proof.js';
import type { UiTrap, UiTraps } from '../domain/knowledge.js';
import type { Ports } from '../ports/index.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { withState } from '../machine/withState.js';
import { getCase, transitionCase } from '../machine/pipeline.js';
import { bumpReuse, readPomIndex } from '../harvest/inventory.js';
import { lastAttempt, readLedger } from '../ledger/store.js';
import { proofArtifactKey } from './deliver.js';
import { safeCaseId } from './filter.js';

export interface AcceptParams {
  runId: string;
  caseId: string;
  targetBranch: string;
  /**
   * Kto podjął decyzję. Domyślnie człowiek - komenda `accept` istnieje właśnie
   * po to. Krok auto-accept przekazuje `pipeline`, żeby opis PR nie deklarował
   * decyzji, której nikt nie podjął.
   */
  acceptedBy?: 'human' | 'pipeline';
}

export interface AcceptResult {
  prUrl: string;
}

export async function runAccept(
  ports: Ports,
  config: GreenproofConfig,
  params: AcceptParams,
): Promise<AcceptResult> {
  return withState(ports, params.runId, async (state) => {
    const cs = getCase(state, params.caseId);
    const branch = cs.branch;
    if (!branch) throw new Error(`Case ${params.caseId} has no author branch`);

    // Użyte POM-y dostają +1 na branchu case'a - wejdą do PR razem ze specem.
    const ledger = await readLedger(ports.artifacts, state.runId, params.caseId);
    const last = lastAttempt(ledger);
    if (last && last.reusedPoms.length > 0) {
      const index = await readPomIndex(ports.scm, branch, config);
      const bumped = bumpReuse(index, last.reusedPoms);
      await ports.scm.commitFiles(
        branch,
        [{ path: config.paths.pomIndex, content: JSON.stringify(bumped, null, 2) }],
        `chore(greenproof): bump POM reuse counters for ${params.caseId}`,
      );
    }

    // proposals/<case>.yaml → merge do ui-traps.yaml (na branchu - widoczne w diffie PR).
    await promoteTrapProposals(ports, config, branch, params.caseId);

    const proofBuf = cs.artifacts.proof
      ? await ports.artifacts.get(state.runId, cs.artifacts.proof)
      : await ports.artifacts.get(state.runId, proofArtifactKey(params.caseId));
    const proof = proofBuf ? (JSON.parse(proofBuf.toString('utf8')) as MutationProof) : null;

    const pr = await ports.scm.openPullRequest({
      from: branch,
      to: params.targetBranch,
      title: `test(e2e): ${params.caseId}`,
      body: prBody(params.caseId, state.runId, proof, last?.reusedPoms ?? [], params.acceptedBy ?? 'human'),
    });

    transitionCase(state, params.caseId, 'accepted');
    return { prUrl: pr.url };
  });
}

async function promoteTrapProposals(
  ports: Ports,
  config: GreenproofConfig,
  branch: string,
  caseId: string,
): Promise<void> {
  if (!config.knowledge) return;
  const proposalPath = `${config.knowledge.dir}/proposals/${safeCaseId(caseId)}.yaml`;
  const raw = await ports.scm.readFile(branch, proposalPath);
  if (!raw) return;
  let traps: UiTrap[] = [];
  try {
    traps = (parseYaml(raw) as { traps?: UiTrap[] }).traps ?? [];
  } catch {
    return;
  }
  if (traps.length === 0) return;

  const trapsPath = `${config.knowledge.dir}/ui-traps.yaml`;
  const existingRaw = await ports.scm.readFile(branch, trapsPath);
  const existing: UiTraps = existingRaw
    ? ((parseYaml(existingRaw) as UiTraps) ?? { version: 1, traps: [] })
    : { version: 1, traps: [] };
  const known = new Set(existing.traps.map((t) => `${t.component}::${t.trap}`));
  const merged: UiTraps = {
    version: 1,
    traps: [...existing.traps, ...traps.filter((t) => !known.has(`${t.component}::${t.trap}`))],
  };
  await ports.scm.commitFiles(
    branch,
    [
      { path: trapsPath, content: stringifyYaml(merged) },
      { path: proposalPath, content: null },
    ],
    `docs(greenproof): promote UI-trap proposals from ${caseId}`,
  );
}

function prBody(
  caseId: string,
  runId: string,
  proof: MutationProof | null,
  reusedPoms: string[],
  acceptedBy: 'human' | 'pipeline',
): string {
  const lines = [
    acceptedBy === 'human'
      ? `Draft E2E wygenerowany przez greenproof (run \`${runId}\`), zaakceptowany przez człowieka.`
      : `Draft E2E wygenerowany przez greenproof (run \`${runId}\`), przyjęty automatycznie: dowód mutacyjny \`valid\` bez ostrzeżeń i czysty lint. Decyzją człowieka pozostaje \`release\`.`,
    '',
    proof
      ? proof.verdict === 'valid'
        ? `✅ Dowód mutacyjny **valid** - mutacja: ${proof.mutation.description}`
        : `❌ Dowód mutacyjny **invalid**: ${proof.reasons.join('; ')}`
      : '⚠️ Brak dowodu mutacyjnego',
  ];
  if (reusedPoms.length > 0) {
    lines.push('', `Reużyte POM-y: ${reusedPoms.map((p) => `\`${p}\``).join(', ')}`);
  }
  return lines.join('\n');
}
