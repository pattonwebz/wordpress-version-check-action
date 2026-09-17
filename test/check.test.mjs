import test from 'node:test';
import assert from 'node:assert/strict';

import {
	TITLES,
	api,
	buildBody,
	compareVersions,
	decide,
	findIssue,
	normalizeVersion,
	parseInputs,
	parseTestedUpTo,
	readVersions,
	run,
} from '../check.mjs';

const MARKER = '<!-- wp-version-check:tested-up-to -->';
const BASE_ENV = {
	GITHUB_REPOSITORY: 'pattonwebz/demo',
	GITHUB_TOKEN: 'tok',
	INPUT_MARKER: MARKER,
};

const readme = (version) => `=== Plugin ===\nTested up to: ${version}\nStable tag: 1.0\n`;
const OFFERS_CURRENT = [
	{ response: 'development', current: '7.1.1-RC1' },
	{ response: 'upgrade', current: '7.1' },
];
const OFFERS_OUTDATED = [
	{ response: 'development', current: '7.3-RC1' },
	{ response: 'upgrade', current: '7.2' },
];
const OFFERS_RC_ONLY = [
	{ response: 'development', current: '7.2-RC2' },
	{ response: 'upgrade', current: '7.1' },
];

const botIssue = (body, extra = {}) => ({
	number: 42,
	title: TITLES.stable,
	body,
	user: { login: 'github-actions[bot]' },
	...extra,
});

// Stubs the GitHub API and the WordPress version API so run() can be exercised with no network.
function harness({ offers = OFFERS_CURRENT, content = readme('7.1'), issues = [], env = {} } = {}) {
	const writes = [];
	const logs = [];
	const apiImpl = {
		defaultBranch: async () => 'develop',
		readFile: async (path) => {
			if (content === null) {
				throw new Error(`GitHub API GET /contents/${path} failed: 404 Not Found — nope`);
			}
			return content;
		},
		listOpenIssues: async () => issues,
		createIssue: async (fields) => {
			writes.push({ kind: 'create', fields });
			return { number: 99 };
		},
		updateIssue: async (number, fields) => {
			writes.push({ kind: 'update', number, fields });
		},
		comment: async (number, body) => {
			writes.push({ kind: 'comment', number, body });
		},
	};
	return {
		writes,
		logs,
		api: apiImpl,
		run: () =>
			run({ ...BASE_ENV, ...env }, (line) => logs.push(line), {
				api: apiImpl,
				versions: readVersions({ offers }),
			}),
	};
}

// ---------------------------------------------------------------- parseInputs

test('parseInputs applies defaults', () => {
	const config = parseInputs({ ...BASE_ENV });
	assert.deepEqual(config.readmes, ['readme.txt']);
	assert.equal(config.channel, 'rc');
	assert.deepEqual(config.assignees, []);
	assert.equal(config.marker, MARKER);
	assert.equal(config.dryRun, false);
	assert.equal(config.owner, 'pattonwebz');
	assert.equal(config.repo, 'demo');
});

test('parseInputs splits readme and assignee lists on newlines and commas', () => {
	const config = parseInputs({
		...BASE_ENV,
		INPUT_README: 'readme.txt, src/readme.md\ndocs/readme.txt',
		INPUT_ASSIGNEES: 'amberhinds, pattonwebz',
	});
	assert.deepEqual(config.readmes, ['readme.txt', 'src/readme.md', 'docs/readme.txt']);
	assert.deepEqual(config.assignees, ['amberhinds', 'pattonwebz']);
});

test('parseInputs accepts the three channels case-insensitively and rejects others', () => {
	for (const channel of ['stable', 'rc', 'beta', 'RC', ' Beta ']) {
		assert.equal(parseInputs({ ...BASE_ENV, INPUT_CHANNEL: channel }).channel, channel.trim().toLowerCase());
	}
	assert.throws(() => parseInputs({ ...BASE_ENV, INPUT_CHANNEL: 'nightly' }), /Invalid channel/);
});

test('parseInputs requires a repository and a token', () => {
	assert.throws(() => parseInputs({ GITHUB_TOKEN: 'tok' }), /GITHUB_REPOSITORY/);
	assert.throws(() => parseInputs({ GITHUB_REPOSITORY: 'a/b' }), /GITHUB_TOKEN/);
	assert.throws(() => parseInputs({ GITHUB_REPOSITORY: 'a/b', GITHUB_TOKEN: '   ' }), /GITHUB_TOKEN/);
});

test('parseInputs accepts truthy dry-run spellings only', () => {
	for (const value of ['true', 'TRUE', '1', 'yes', ' true ']) {
		assert.equal(parseInputs({ ...BASE_ENV, INPUT_DRY_RUN: value }).dryRun, true, value);
	}
	for (const value of ['false', '0', 'no', '']) {
		assert.equal(parseInputs({ ...BASE_ENV, INPUT_DRY_RUN: value }).dryRun, false, value);
	}
});

// --------------------------------------------------------- version handling

test('normalizeVersion strips patch level and pre-release suffix', () => {
	assert.equal(normalizeVersion('7.1.1-RC1'), '7.1');
	assert.equal(normalizeVersion('7.2-beta3'), '7.2');
	assert.equal(normalizeVersion('7.0'), '7.0');
	assert.equal(normalizeVersion('6.10.4'), '6.10');
});

test('compareVersions compares numerically, not lexically', () => {
	assert.equal(compareVersions('7.10', '7.9'), 1);
	assert.equal(compareVersions('7.1', '7.1'), 0);
	assert.equal(compareVersions('6.9', '7.0'), -1);
});

test('parseTestedUpTo tolerates surrounding whitespace and CRLF', () => {
	assert.equal(parseTestedUpTo('=== Plugin ===\nTested up to: 7.1\nStable tag: 1.0\n'), '7.1');
	assert.equal(parseTestedUpTo('Tested up to: 7.1   \r\n'), '7.1');
	assert.equal(parseTestedUpTo('\tTested up to:\t6.4\n'), '6.4');
	assert.equal(parseTestedUpTo('Tested up to: 7.1\nTested up to: 6.0\n'), '7.1');
	assert.throws(() => parseTestedUpTo('nothing here\n'), /No "Tested up to:" line found/);
});

test('readVersions separates stable, rc and beta', () => {
	assert.deepEqual(readVersions({ offers: [
		{ response: 'development', current: '7.3-beta1' },
		{ response: 'upgrade', current: '7.2' },
	] }), { stable: '7.2', rc: null, beta: '7.3' });

	assert.deepEqual(readVersions({ offers: [
		{ response: 'development', current: '7.3-RC2' },
		{ response: 'upgrade', current: '7.2' },
	] }), { stable: '7.2', rc: '7.3', beta: '7.3' });

	assert.deepEqual(readVersions({ offers: [
		{ response: 'upgrade', current: '7.2' },
	] }), { stable: '7.2', rc: null, beta: null });

	assert.throws(() => readVersions({ offers: [] }), /upgrade/);
	assert.throws(() => readVersions({}), /upgrade/);
});

// ------------------------------------------------------------ decision logic

test('decide prefers stable over rc over beta and honours the channel', () => {
	const versions = { stable: '7.2', rc: '7.3', beta: '7.4' };
	assert.deepEqual(decide('7.1', versions, 'beta'), { kind: 'stable', latest: '7.2' });
	assert.deepEqual(decide('7.2', versions, 'beta'), { kind: 'rc', latest: '7.3' });
	assert.deepEqual(decide('7.3', versions, 'beta'), { kind: 'beta', latest: '7.4' });
	assert.deepEqual(decide('7.4', versions, 'beta'), null);
	assert.deepEqual(decide('7.1', versions, 'rc'), { kind: 'stable', latest: '7.2' });
	assert.deepEqual(decide('7.2', versions, 'rc'), { kind: 'rc', latest: '7.3' });
	assert.deepEqual(decide('7.3', versions, 'rc'), null);
	assert.deepEqual(decide('7.1', versions, 'stable'), { kind: 'stable', latest: '7.2' });
	assert.deepEqual(decide('7.2', versions, 'stable'), null);
	assert.deepEqual(decide('7.1', { stable: '7.2', rc: null, beta: null }, 'rc'), { kind: 'stable', latest: '7.2' });
});

test('buildBody keeps the historical wording and appends the marker last', () => {
	const body = buildBody({ kind: 'stable', tested: '7.1', latest: '7.2', marker: MARKER });
	assert.match(body, /^There is a new WordPress version that the plugin hasn't been tested with\./);
	assert.match(body, /\*\*Tested up to:\*\* 7\.1/);
	assert.match(body, /\*\*Latest version:\*\* 7\.2/);
	assert.match(body, /This issue will be closed automatically when the versions match\./);
	assert.ok(body.endsWith(MARKER));

	const rc = buildBody({ kind: 'rc', tested: '7.2', latest: '7.3', marker: MARKER });
	assert.match(rc, /\*\*Upcoming version:\*\* 7\.3/);
	assert.match(rc, /\*\*release candidate\*\* stage/);

	const beta = buildBody({ kind: 'beta', tested: '7.3', latest: '7.4', marker: MARKER });
	assert.match(beta, /\*\*Beta version:\*\* 7\.4/);
	assert.match(beta, /\*\*beta\*\* stage/);
});

test('TITLES match the strings the action being replaced used', () => {
	assert.equal(TITLES.stable, "The plugin hasn't been tested with the latest version of WordPress");
	assert.equal(TITLES.rc, "The plugin hasn't been tested with an upcoming version of WordPress");
	assert.equal(TITLES.beta, "The plugin hasn't been tested with a beta version of WordPress");
});

// ------------------------------------------------- issue lookup and REST layer

test('findIssue matches the marker, ignoring PRs and missing bodies', () => {
	const issues = [
		{ number: 1, title: 'a PR', body: `x ${MARKER}`, pull_request: {} },
		{ number: 2, title: 'no body', body: null },
		{ number: 3, title: 'human issue', body: 'unrelated' },
	];
	assert.equal(findIssue(issues, MARKER), null);
	assert.equal(findIssue([...issues, { number: 4, title: 'the one', body: `hi\n${MARKER}` }], MARKER).number, 4);
	assert.equal(findIssue([], MARKER), null);
});

test('api sends an authenticated request and maps failures to readable errors', async () => {
	const calls = [];
	const fetchImpl = async (url, options) => {
		calls.push({ url, options });
		return { ok: true, status: 200, json: async () => ({ default_branch: 'develop' }) };
	};
	const gh = api({ owner: 'o', repo: 'r', token: 'tok' }, fetchImpl);

	assert.equal(await gh.defaultBranch(), 'develop');
	assert.equal(calls[0].url, 'https://api.github.com/repos/o/r');
	assert.equal(calls[0].options.headers.authorization, 'Bearer tok');
	assert.equal(calls[0].options.headers.accept, 'application/vnd.github+json');

	const failing = api({ owner: 'o', repo: 'r', token: 'tok' }, async () => ({
		ok: false,
		status: 404,
		statusText: 'Not Found',
		text: async () => 'nope',
	}));
	await assert.rejects(() => failing.defaultBranch(), /404 Not Found/);
});

test('api.readFile decodes base64 and refuses non-file payloads', async () => {
	const gh = api({ owner: 'o', repo: 'r', token: 'tok' }, async () => ({
		ok: true,
		status: 200,
		json: async () => ({ content: Buffer.from(readme('7.1')).toString('base64') }),
	}));
	assert.equal(await gh.readFile('readme.txt', 'develop'), readme('7.1'));

	const directory = api({ owner: 'o', repo: 'r', token: 'tok' }, async () => ({
		ok: true,
		status: 200,
		json: async () => [{ name: 'a' }],
	}));
	await assert.rejects(() => directory.readFile('src', 'develop'), /not a file/);
});

test('api.listOpenIssues reads the GraphQL issues connection and refuses to guess when truncated', async () => {
	const calls = [];
	const respondWith = (connection) => async (url, options) => {
		calls.push({ url, options });
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: { repository: { issues: connection } } }),
		};
	};

	const nodes = [{ number: 7, title: 't', body: 'b' }];
	const gh = api({ owner: 'o', repo: 'r', token: 'tok' }, respondWith({
		nodes,
		pageInfo: { hasNextPage: false },
	}));
	assert.deepEqual(await gh.listOpenIssues(), nodes);
	assert.equal(calls[0].url, 'https://api.github.com/graphql');
	assert.equal(calls[0].options.method, 'POST');

	const payload = JSON.parse(calls[0].options.body);
	assert.match(payload.query, /states: OPEN/);
	assert.deepEqual(payload.variables, { owner: 'o', repo: 'r', first: 100 });

	const full = api({ owner: 'o', repo: 'r', token: 'tok' }, respondWith({
		nodes: [],
		pageInfo: { hasNextPage: true },
	}));
	await assert.rejects(() => full.listOpenIssues(), /More than 100 open issues/);
});

test('api surfaces GraphQL errors that arrive alongside a 200', async () => {
	const gh = api({ owner: 'o', repo: 'r', token: 'tok' }, async () => ({
		ok: true,
		status: 200,
		json: async () => ({ data: null, errors: [{ message: 'Something went wrong' }] }),
	}));
	await assert.rejects(() => gh.listOpenIssues(), /Something went wrong/);
});

// ------------------------------------------------------------------ run()

test('run: up to date with no tracking issue does nothing', async () => {
	const h = harness({ offers: OFFERS_CURRENT });
	const result = await h.run();
	assert.equal(result.action, 'none');
	assert.deepEqual(h.writes, []);
	assert.ok(h.logs.some((line) => /Readme is current/.test(line)));
});

test('run: up to date with a tracking issue comments then closes', async () => {
	const h = harness({ offers: OFFERS_CURRENT, issues: [botIssue(`old\n${MARKER}`)] });
	const result = await h.run();
	assert.equal(result.action, 'closed');
	assert.equal(result.issueNumber, '42');
	assert.deepEqual(h.writes.map((w) => w.kind), ['comment', 'update']);
	assert.match(h.writes[0].body, /matches the latest version now, closing this issue/);
	assert.equal(h.writes[1].fields.state, 'closed');
});

test('run: outdated stable with no issue creates one — and never passes a label', async () => {
	const h = harness({ offers: OFFERS_OUTDATED });
	const result = await h.run();
	assert.equal(result.action, 'created');
	assert.equal(result.issueNumber, '99');
	assert.equal(h.writes.length, 1);
	const { fields } = h.writes[0];
	assert.equal(h.writes[0].kind, 'create');
	assert.equal(fields.title, TITLES.stable);
	assert.ok(!('labels' in fields), 'create must not pass labels');
	assert.ok(!('assignees' in fields), 'no assignees means no key at all');
	assert.ok(fields.body.includes(MARKER));
});

test('run: assignees input is forwarded on create only', async () => {
	const h = harness({ offers: OFFERS_OUTDATED, env: { INPUT_ASSIGNEES: 'amberhinds, pattonwebz' } });
	await h.run();
	assert.deepEqual(h.writes[0].fields.assignees, ['amberhinds', 'pattonwebz']);
});

test('run: outdated stable with an identical issue writes nothing', async () => {
	const body = buildBody({ kind: 'stable', tested: '7.1', latest: '7.2', marker: MARKER });
	const h = harness({ offers: OFFERS_OUTDATED, issues: [botIssue(body)] });
	const result = await h.run();
	assert.equal(result.action, 'unchanged');
	assert.equal(result.issueNumber, '42');
	assert.deepEqual(h.writes, []);
});

test('run: outdated stable with a stale body updates and keeps the marker', async () => {
	const h = harness({ offers: OFFERS_OUTDATED, issues: [botIssue(`stale\n${MARKER}`)] });
	const result = await h.run();
	assert.equal(result.action, 'updated');
	assert.equal(h.writes.length, 1);
	assert.equal(h.writes[0].kind, 'update');
	assert.equal(h.writes[0].number, 42);
	assert.equal(h.writes[0].fields.title, TITLES.stable);
	assert.ok(h.writes[0].fields.body.includes(MARKER));
	assert.match(h.writes[0].fields.body, /\*\*Latest version:\*\* 7\.2/);
});

test('run: an rc-only lag opens the upcoming-version issue', async () => {
	const h = harness({ offers: OFFERS_RC_ONLY });
	const result = await h.run();
	assert.equal(result.action, 'created');
	assert.equal(h.writes[0].fields.title, TITLES.rc);
	assert.match(h.writes[0].fields.body, /\*\*Upcoming version:\*\* 7\.2/);
});

test('run: dry run performs no writes but reports the intended action', async () => {
	const scenarios = [
		{ offers: OFFERS_OUTDATED, issues: [], expected: 'created' },
		{ offers: OFFERS_OUTDATED, issues: [botIssue(`stale\n${MARKER}`)], expected: 'updated' },
		{ offers: OFFERS_CURRENT, issues: [botIssue(`old\n${MARKER}`)], expected: 'closed' },
		{ offers: OFFERS_CURRENT, issues: [], expected: 'none' },
	];
	for (const scenario of scenarios) {
		const h = harness({ ...scenario, env: { INPUT_DRY_RUN: 'true' } });
		const result = await h.run();
		assert.deepEqual(h.writes, [], `dry run must not write (${scenario.expected})`);
		assert.equal(result.action, scenario.expected);
		assert.ok(h.logs.some((line) => line.startsWith('::notice::')), 'dry run must explain itself');
	}
});

test('run: a missing readme fails loudly and names every path tried', async () => {
	const h = harness({ content: null, env: { INPUT_README: 'readme.txt, src/readme.md' } });
	await assert.rejects(() => h.run(), /readme\.txt, src\/readme\.md/);
});

test('run: a readme without a "Tested up to" line fails loudly', async () => {
	const h = harness({ content: '=== Plugin ===\nStable tag: 1.0\n' });
	await assert.rejects(() => h.run(), /No "Tested up to:" line found/);
});

test('run: writes GitHub outputs when GITHUB_OUTPUT is set', async () => {
	const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = mkdtempSync(join(tmpdir(), 'wpvc-'));
	const outputPath = join(dir, 'out.txt');
	try {
		const h = harness({ offers: OFFERS_OUTDATED, env: { GITHUB_OUTPUT: outputPath } });
		await h.run();
		const written = readFileSync(outputPath, 'utf8');
		assert.match(written, /action=created/);
		assert.match(written, /issue-number=99/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
