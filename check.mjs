/**
 * WordPress "tested up to" checker.
 *
 * Opens a tracking issue when a plugin readme is behind the current WordPress release, keeps that
 * issue up to date while the gap persists, and comments + closes it once the readme catches up.
 *
 * No labels: the tracking issue is identified by a hidden marker in its body (see the `marker`
 * input). Run with `dry-run: true` to log the decision without writing anything.
 *
 * Requires Node 18+ for global fetch. Zero dependencies, on purpose.
 */

import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_ROOT = 'https://api.github.com';
const WP_VERSION_API = 'https://api.wordpress.org/core/version-check/1.7/';
const CLOSE_COMMENT = 'The "Tested up to" version in the readme matches the latest version now, closing this issue.';
const MAX_ISSUES = 100;

export const TITLES = {
	stable: "The plugin hasn't been tested with the latest version of WordPress",
	rc: "The plugin hasn't been tested with an upcoming version of WordPress",
	beta: "The plugin hasn't been tested with a beta version of WordPress",
};

const INTROS = {
	stable:
		"There is a new WordPress version that the plugin hasn't been tested with. Please test it and then change the \"Tested up to\" field in the plugin readme.",
	rc: "There is an upcoming WordPress version in the **release candidate** stage that the plugin hasn't been tested with. Please test it and then change the \"Tested up to\" field in the plugin readme.",
	beta: "There is an upcoming WordPress version in the **beta** stage that the plugin hasn't been tested with. Please test it and then change the \"Tested up to\" field in the plugin readme.",
};

const VERSION_LABELS = {
	stable: 'Latest version',
	rc: 'Upcoming version',
	beta: 'Beta version',
};

const CHANNEL_ORDER = {
	stable: ['stable'],
	rc: ['stable', 'rc'],
	beta: ['stable', 'rc', 'beta'],
};

// ----------------------------------------------------------------- inputs

export function parseInputs(env) {
	const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/');
	if (!owner || !repo) {
		throw new Error('GITHUB_REPOSITORY is not set (expected "owner/repo").');
	}

	const token = String(env.GITHUB_TOKEN || '').trim();
	if (!token) {
		throw new Error('GITHUB_TOKEN is empty — pass a token with issues: write.');
	}

	const channel = String(env.INPUT_CHANNEL || 'rc').trim().toLowerCase();
	if (!Object.keys(CHANNEL_ORDER).includes(channel)) {
		throw new Error(`Invalid channel "${channel}" — expected stable, rc or beta.`);
	}

	const splitList = (value) =>
		String(value || '')
			.split(/[\n,]+/)
			.map((item) => item.trim())
			.filter(Boolean);

	const readmes = splitList(env.INPUT_README || 'readme.txt');
	if (readmes.length === 0) {
		throw new Error('No readme path given.');
	}

	return {
		owner,
		repo,
		token,
		readmes,
		channel,
		assignees: splitList(env.INPUT_ASSIGNEES),
		marker: String(env.INPUT_MARKER || '<!-- wp-version-check:tested-up-to -->').trim(),
		dryRun: /^(1|true|yes)$/i.test(String(env.INPUT_DRY_RUN || 'false').trim()),
	};
}

// ---------------------------------------------------------------- versions

/** "7.1.1-RC1" -> "7.1"; "7.2-beta3" -> "7.2" */
export function normalizeVersion(version) {
	return String(version).split('-')[0].split('.').slice(0, 2).join('.');
}

/** -1 | 0 | 1, compared numerically so that 7.10 is newer than 7.9. */
export function compareVersions(a, b) {
	const left = String(a).split('.').map(Number);
	const right = String(b).split('.').map(Number);
	for (let i = 0; i < 2; i++) {
		if ((left[i] || 0) !== (right[i] || 0)) {
			return (left[i] || 0) < (right[i] || 0) ? -1 : 1;
		}
	}
	return 0;
}

export function parseTestedUpTo(readme) {
	for (const line of String(readme).split(/\r?\n/)) {
		const match = /^\s*Tested up to:\s*([.\d]+)\s*$/.exec(line);
		if (match) {
			return match[1];
		}
	}
	throw new Error('No "Tested up to:" line found in the readme.');
}

export function readVersions(payload) {
	const offers = Array.isArray(payload?.offers) ? payload.offers : [];
	const stable = offers.find((offer) => offer.response === 'upgrade')?.current;
	if (!stable) {
		throw new Error('No "upgrade" offer in the WordPress version API response.');
	}
	const development = offers.find((offer) => offer.response === 'development')?.current ?? '';
	const isRc = /-RC\d*$/i.test(development);
	const isBeta = /-beta\d*$/i.test(development);
	return {
		stable: normalizeVersion(stable),
		rc: isRc ? normalizeVersion(development) : null,
		beta: isRc || isBeta ? normalizeVersion(development) : null,
	};
}

// ---------------------------------------------------------------- decision

/** Returns null when the readme is current, otherwise { kind, latest }. */
export function decide(tested, versions, channel) {
	for (const kind of CHANNEL_ORDER[channel]) {
		const latest = versions[kind];
		if (latest && compareVersions(tested, latest) < 0) {
			return { kind, latest };
		}
	}
	return null;
}

export function buildBody({ kind, tested, latest, marker }) {
	return [
		INTROS[kind],
		'',
		`**Tested up to:** ${tested}`,
		`**${VERSION_LABELS[kind]}:** ${latest}`,
		'',
		'This issue will be closed automatically when the versions match.',
		'',
		marker,
	].join('\n');
}

// ------------------------------------------------------------ GitHub access

/** The tracking issue is whichever open issue carries the marker. PRs never match. */
export function findIssue(issues, marker) {
	return (
		issues.find(
			(issue) => !issue.pull_request && typeof issue.body === 'string' && issue.body.includes(marker),
		) ?? null
	);
}

export function api(config, fetchImpl = fetch) {
	const base = `/repos/${config.owner}/${config.repo}`;

	const request = async (path, { method = 'GET', body } = {}) => {
		const response = await fetchImpl(`${API_ROOT}${path}`, {
			method,
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${config.token}`,
				'x-github-api-version': '2022-11-28',
				'user-agent': 'wordpress-version-check-action',
				...(body ? { 'content-type': 'application/json' } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (!response.ok) {
			const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 300) : '';
			throw new Error(
				`GitHub API ${method} ${path} failed: ${response.status} ${response.statusText} — ${detail}`,
			);
		}
		return response.status === 204 ? null : response.json();
	};

	return {
		defaultBranch: async () => (await request(base)).default_branch,

		readFile: async (path, ref) => {
			const data = await request(`${base}/contents/${path}?ref=${encodeURIComponent(ref)}`);
			if (typeof data.content !== 'string') {
				throw new Error(`Could not read ${path} — not a file?`);
			}
			return Buffer.from(data.content, 'base64').toString('utf8');
		},

		listOpenIssues: async () => {
			const issues = await request(`${base}/issues?state=open&per_page=${MAX_ISSUES}`);
			if (issues.length >= MAX_ISSUES) {
				throw new Error(
					`More than ${MAX_ISSUES} open issues — this action refuses to guess which issue it owns. Narrow the lookup before re-running.`,
				);
			}
			return issues;
		},

		createIssue: async (fields) => request(`${base}/issues`, { method: 'POST', body: fields }),

		updateIssue: async (number, fields) =>
			request(`${base}/issues/${number}`, { method: 'PATCH', body: fields }),

		comment: async (number, body) =>
			request(`${base}/issues/${number}/comments`, { method: 'POST', body: { body } }),
	};
}

export async function wordpressVersions(fetchImpl = fetch) {
	const response = await fetchImpl(`${WP_VERSION_API}?channel=beta`);
	if (!response.ok) {
		throw new Error(`api.wordpress.org returned HTTP ${response.status}.`);
	}
	return readVersions(await response.json());
}

// ------------------------------------------------------------------- run

async function readFirstReadme(gh, config, ref) {
	let lastError;
	for (const path of config.readmes) {
		try {
			return { path, content: await gh.readFile(path, ref) };
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`No readme found at any of: ${config.readmes.join(', ')}. Last error: ${lastError?.message}`,
	);
}

function writeOutputs(env, result) {
	if (!env.GITHUB_OUTPUT) {
		return;
	}
	appendFileSync(env.GITHUB_OUTPUT, `action=${result.action}\nissue-number=${result.issueNumber}\n`);
}

export async function run(env = process.env, log = console.log, deps = {}) {
	if (typeof fetch !== 'function' && !deps.api) {
		throw new Error('This action needs Node 18 or newer (global fetch is unavailable).');
	}

	const config = parseInputs(env);
	const gh = deps.api ?? api(config);
	const versions = deps.versions ?? (await wordpressVersions());

	const branch = await gh.defaultBranch();
	const { path, content } = await readFirstReadme(gh, config, branch);
	const tested = parseTestedUpTo(content);
	const issue = findIssue(await gh.listOpenIssues(), config.marker);
	const decision = decide(tested, versions, config.channel);
	const result = { action: 'none', issueNumber: '' };

	log(
		`::notice::${path} on ${branch}: "Tested up to" is ${tested}; WordPress stable ${versions.stable}` +
			`${versions.rc ? `, rc ${versions.rc}` : ''}.${config.dryRun ? ' (dry run)' : ''}`,
	);

	if (!decision) {
		if (!issue) {
			log('::notice::Readme is current — nothing to do.');
		} else {
			result.action = 'closed';
			result.issueNumber = String(issue.number);
			if (config.dryRun) {
				log(`::notice::Dry run — would comment on and close #${issue.number}.`);
			} else {
				await gh.comment(issue.number, CLOSE_COMMENT);
				await gh.updateIssue(issue.number, { state: 'closed' });
				log(`::notice::Closed #${issue.number} — readme is current.`);
			}
		}
	} else {
		const title = TITLES[decision.kind];
		const body = buildBody({ ...decision, tested, marker: config.marker });

		if (!issue) {
			result.action = 'created';
			if (config.dryRun) {
				log(`::notice::Dry run — would open "${title}" (tested ${tested} < ${decision.latest}).`);
			} else {
				const created = await gh.createIssue({
					title,
					body,
					...(config.assignees.length ? { assignees: config.assignees } : {}),
				});
				result.issueNumber = String(created.number);
				log(`::notice::Opened #${created.number} — tested ${tested} < ${decision.latest}.`);
			}
		} else {
			result.issueNumber = String(issue.number);
			if (issue.title === title && issue.body === body) {
				result.action = 'unchanged';
				log(`::notice::#${issue.number} is already up to date.`);
			} else {
				result.action = 'updated';
				if (config.dryRun) {
					log(`::notice::Dry run — would update #${issue.number} (tested ${tested} < ${decision.latest}).`);
				} else {
					await gh.updateIssue(issue.number, { title, body });
					log(`::notice::Updated #${issue.number} (tested ${tested} < ${decision.latest}).`);
				}
			}
		}
	}

	writeOutputs(env, result);
	return result;
}

function isDirectInvocation() {
	if (!process.argv[1]) {
		return false;
	}
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isDirectInvocation()) {
	run().catch((error) => {
		console.log(`::error::${error.message}`);
		process.exit(1);
	});
}
