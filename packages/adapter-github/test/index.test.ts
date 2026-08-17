import type { SecretsPort } from '@greenproof/core';
import { describe, expect, it } from 'vitest';
import createGithubPlatform, {
  DEFAULT_ARTIFACTS_BRANCH,
  DEFAULT_STATE_BRANCH,
  createGithubPorts,
} from '../src/index.js';
import { FakeOctokit, fakeLogger } from './fake-octokit.js';

const secrets = (values: Record<string, string>): SecretsPort => ({
  get: (name) => values[name],
});

describe('createGithubPorts', () => {
  it('spina porty na wstrzykniętym kliencie (zero sieci)', async () => {
    const fake = new FakeOctokit();
    fake.seed('main', { 'README.md': '# test\n' });
    const ports = createGithubPorts({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
      secrets: secrets({}),
    });

    await ports.scm.ensureBranch('author/case-1', 'main');
    await ports.artifacts.put('run-1', 'a.txt', Buffer.from('a', 'utf8'));
    await ports.state.save('run-1', { runId: 'run-1' } as never, null);
    await ports.human.postReport('7', {
      kind: 'roster',
      title: 'Roster',
      markdown: 'lista',
      data: null,
      reportId: 'run-1:roster',
    });

    expect(fake.refs.has('heads/author/case-1')).toBe(true);
    expect(fake.refs.has(`heads/${DEFAULT_ARTIFACTS_BRANCH}`)).toBe(true);
    expect(fake.refs.has(`heads/${DEFAULT_STATE_BRANCH}`)).toBe(true);
    expect(fake.commentBodies(7)).toHaveLength(1);
    expect(ports.clock.now()).toBeInstanceOf(Date);
  });
});

describe('domyślna fabryka platformy', () => {
  const base = { platformOptions: { owner: 'acme', repo: 'tests' } };

  it('czytelnie zgłasza brak tokenu', () => {
    expect(() =>
      createGithubPlatform({ config: base, secrets: secrets({}), logger: fakeLogger() }),
    ).toThrow(/GITHUB_TOKEN/);
  });

  it('honoruje tokenEnv i buduje porty', async () => {
    const ports = await createGithubPlatform({
      config: {
        platformOptions: { owner: 'acme', repo: 'tests', tokenEnv: 'GH_PAT', baseUrl: 'https://ghe.local/api/v3' },
      },
      secrets: secrets({ GH_PAT: 'x' }),
      logger: fakeLogger(),
    });
    expect(typeof ports.scm.ensureBranch).toBe('function');
    expect(typeof ports.state.save).toBe('function');
  });

  it('waliduje wymagane pola platformOptions', () => {
    expect(() =>
      createGithubPlatform({
        config: { platformOptions: {} },
        secrets: secrets({}),
        logger: fakeLogger(),
      }),
    ).toThrow(/owner, repo/);
  });
});
