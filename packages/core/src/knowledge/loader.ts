/**
 * Ładowanie wiedzy projektowej z repo testów. Wszystko opcjonalne - brak
 * plików to normalny stan (projekt bez wiedzy działa, tylko drożej).
 */
import { parse as parseYaml } from 'yaml';
import type {
  AppMap,
  AppMapView,
  LearnedChurnList,
  UiTrap,
  UiTraps,
} from '../domain/knowledge.js';
import type { GreenproofConfig } from '../config/types.js';
import type { Logger, ScmPort } from '../ports/index.js';

const EMPTY_TRAPS: UiTraps = { version: 1, traps: [] };
const EMPTY_MAP: AppMap = { version: 1, views: [] };
const EMPTY_CHURN: LearnedChurnList = { version: 1, entries: [] };

async function readYaml<T>(
  scm: ScmPort,
  ref: string,
  path: string,
  fallback: T,
  logger: Logger,
): Promise<T> {
  const raw = await scm.readFile(ref, path);
  if (raw === null) return fallback;
  try {
    return parseYaml(raw) as T;
  } catch (err) {
    logger.warn(`Nieparsowalny plik wiedzy ${path} - ignoruję`, err);
    return fallback;
  }
}

export async function loadUiTraps(
  scm: ScmPort,
  ref: string,
  config: GreenproofConfig,
  logger: Logger,
): Promise<UiTraps> {
  if (!config.knowledge) return EMPTY_TRAPS;
  return readYaml(scm, ref, `${config.knowledge.dir}/ui-traps.yaml`, EMPTY_TRAPS, logger);
}

export async function loadAppMap(
  scm: ScmPort,
  ref: string,
  config: GreenproofConfig,
  logger: Logger,
): Promise<AppMap> {
  if (!config.knowledge) return EMPTY_MAP;
  return readYaml(scm, ref, `${config.knowledge.dir}/app-map.yaml`, EMPTY_MAP, logger);
}

export const LEARNED_CHURN_FILE = 'churn-prone.learned.json';

export async function loadLearnedChurn(
  scm: ScmPort,
  ref: string,
  config: GreenproofConfig,
  logger: Logger,
): Promise<LearnedChurnList> {
  if (!config.knowledge || config.caps.seedFuse.learn === 'off') return EMPTY_CHURN;
  const raw = await scm.readFile(ref, `${config.knowledge.dir}/${LEARNED_CHURN_FILE}`);
  if (raw === null) return EMPTY_CHURN;
  try {
    return JSON.parse(raw) as LearnedChurnList;
  } catch (err) {
    logger.warn('Nieparsowalny churn-prone.learned.json - ignoruję', err);
    return EMPTY_CHURN;
  }
}

/** Ręczna ∪ nauczone AKTYWNE wpisy. */
export function effectiveChurnTypes(
  config: GreenproofConfig,
  learned: LearnedChurnList,
): Set<string> {
  const types = new Set(config.caps.seedFuse.churnProneTypes);
  for (const e of learned.entries) {
    if (e.status === 'active') types.add(e.type);
  }
  return types;
}

export function isChurnProne(
  churnTypes: Set<string>,
  c: { type?: string; flows: string[] },
): boolean {
  if (c.type && churnTypes.has(c.type)) return true;
  return c.flows.some((f) => churnTypes.has(f));
}

/** Traps dla flow case'a; pusty appliesTo pasuje zawsze. */
export function trapsForFlows(traps: UiTraps, flows: string[]): UiTrap[] {
  return traps.traps.filter(
    (t) => t.appliesTo.length === 0 || t.appliesTo.some((tag) => flows.includes(tag)),
  );
}

export function viewsForFlows(map: AppMap, flows: string[]): AppMapView[] {
  return map.views.filter((v) =>
    flows.some((f) => v.route === f || v.route.startsWith(`${f}/`) || f.startsWith(`${v.route}/`)),
  );
}
