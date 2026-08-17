/** Złożenie wszystkich fake'ów w komplet Ports + uchwyty do asercji. */
import type { Ports } from '@greenproof/core';
import { InMemoryScm } from './scm.js';
import { InMemoryArtifactStore } from './artifacts.js';
import { InMemoryStateStore } from './state.js';
import { CapturingHumanChannel } from './human.js';
import { EnvSecrets, FixedClock, TestLogger } from './misc.js';

export interface FakePorts {
  /** Komplet portów do wstrzyknięcia do core'a. */
  ports: Ports;
  scm: InMemoryScm;
  artifacts: InMemoryArtifactStore;
  state: InMemoryStateStore;
  human: CapturingHumanChannel;
  secrets: EnvSecrets;
  logger: TestLogger;
  clock: FixedClock;
}

/**
 * Buduje fake porty; overrides podmienia wybrane porty (uchwyty typowane
 * zostają fake'ami - nadpisany port nie jest przez nie obserwowany).
 */
export function makeFakePorts(overrides?: Partial<Ports>): FakePorts {
  const scm = new InMemoryScm();
  const artifacts = new InMemoryArtifactStore();
  const state = new InMemoryStateStore();
  const human = new CapturingHumanChannel();
  const secrets = new EnvSecrets();
  const logger = new TestLogger();
  const clock = new FixedClock();

  const ports: Ports = {
    scm,
    artifacts,
    state,
    human,
    secrets,
    logger,
    clock,
    ...(overrides ?? {}),
  };

  return { ports, scm, artifacts, state, human, secrets, logger, clock };
}
