import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GITHUB_API_URL, GITHUB_API_VERSION } from "./constants.ts";
import { encodePath, normalizeRepoPath } from "./path-utils.ts";
import {
	readRepoMetadataCache,
	readRepoRefCache,
	readRepoTreeCache,
	writeRepoMetadataCache,
	writeRepoRefCache,
	writeRepoTreeCache,
	looksLikeCommitSha,
} from "./store.ts";
import type {
	GitHubCommitResponse,
	GitHubContentFile,
	GitHubContentObject,
	GitHubRepo,
	GitHubRepoMetadata,
	GitHubTreeResponse,
} from "./types.ts";

const execFileAsync = promisify(execFile);

const repoMetadataCache = new Map<string, Promise<GitHubRepoMetadata>>();
const repoTreeCache = new Map<string, Promise<{ ref: string; tree: GitHubTreeResponse }>>();
const repoFileCache = new Map<string, Promise<string>>();
const repoCommitCache = new Map<string, Promise<string>>();
let cachedGitHubToken: Promise<string | null> | null = null;

export async function githubFetch(
	path: string,
	accept = "application/vnd.github+json",
	explicitToken?: string,
	signal?: AbortSignal,
): Promise<Response> {
	const token = explicitToken ?? (await getGitHubToken());
	const headers: Record<string, string> = {
		Accept: accept,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		"User-Agent": "pi-repos",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const url = path.startsWith("http://") || path.startsWith("https://") ? path : `${GITHUB_API_URL}${path}`;
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`GitHub API request failed (${response.status}): ${errorText}`);
	}
	return response;
}

export async function githubJson<T>(path: string, accept = "application/vnd.github+json", explicitToken?: string): Promise<T> {
	const response = await githubFetch(path, accept, explicitToken);
	return (await response.json()) as T;
}

export async function getGitHubToken(): Promise<string | null> {
	const envToken =
		process.env.GITHUB_TOKEN?.trim() ||
		process.env.GH_TOKEN?.trim() ||
		process.env.GITHUB_PAT?.trim() ||
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim();
	if (envToken) return envToken;
	if (!cachedGitHubToken) {
		cachedGitHubToken = execFileAsync("gh", ["auth", "token"])
			.then(result => result.stdout.trim() || null)
			.catch(() => null);
	}
	return cachedGitHubToken;
}

export function parseRepoInput(input: string): GitHubRepo {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Repository is required.");
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		const url = new URL(trimmed);
		if (url.hostname !== "github.com") {
			throw new Error(`Unsupported repository host: ${url.hostname}`);
		}
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length < 2) throw new Error(`Invalid GitHub repository URL: ${input}`);
		return { owner: parts[0], name: parts[1].replace(/\.git$/, "") };
	}
	const [owner, name] = trimmed.split("/");
	if (!owner || !name) throw new Error(`Invalid repository identifier: ${input}`);
	return { owner, name: name.replace(/\.git$/, "") };
}

export function repoKey(repo: GitHubRepo): string {
	return `${repo.owner}/${repo.name}`;
}

export async function getRepoMetadata(repo: GitHubRepo): Promise<GitHubRepoMetadata> {
	const key = repoKey(repo);
	let cached = repoMetadataCache.get(key);
	if (!cached) {
		cached = githubJson<GitHubRepoMetadata>(`/repos/${repo.owner}/${repo.name}`).then(metadata => {
			void writeRepoMetadataCache(repo, metadata.default_branch);
			return metadata;
		});
		repoMetadataCache.set(key, cached);
	}
	return cached;
}

export async function resolveRepoRef(repo: GitHubRepo, ref?: string): Promise<string> {
	if (ref?.trim()) return ref.trim();
	const cachedMetadata = await readRepoMetadataCache(repo);
	if (cachedMetadata?.defaultBranch) return cachedMetadata.defaultBranch;
	const metadata = await getRepoMetadata(repo);
	return metadata.default_branch;
}

export async function getRepoTree(repo: GitHubRepo, ref?: string): Promise<{ ref: string; tree: GitHubTreeResponse }> {
	const resolvedRef = await resolveRepoRef(repo, ref);
	const key = `${repoKey(repo)}@${resolvedRef}`;
	let cached = repoTreeCache.get(key);
	if (!cached) {
		cached = (async () => {
			const cachedTree = await readRepoTreeCache(repo, resolvedRef);
			if (cachedTree) return { ref: resolvedRef, tree: cachedTree };
			const tree = await githubJson<GitHubTreeResponse>(
				`/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`,
			);
			if (looksLikeCommitSha(resolvedRef)) void writeRepoTreeCache(repo, resolvedRef, tree);
			return { ref: resolvedRef, tree };
		})();
		repoTreeCache.set(key, cached);
	}
	return cached;
}

export async function getRepoFileText(repo: GitHubRepo, ref: string, path: string): Promise<string> {
	const normalizedPath = normalizeRepoPath(path);
	const key = `${repoKey(repo)}@${ref}:${normalizedPath}`;
	let cached = repoFileCache.get(key);
	if (!cached) {
		cached = githubJson<GitHubContentFile | GitHubContentObject>(
			`/repos/${repo.owner}/${repo.name}/contents/${encodePath(normalizedPath)}?ref=${encodeURIComponent(ref)}`,
			"application/vnd.github.object+json",
		).then(async result => {
			const file = result as GitHubContentFile;
			if (file.type !== "file") {
				throw new Error(`${normalizedPath} is not a file.`);
			}
			if (typeof file.content === "string" && file.content.length > 0 && file.encoding === "base64") {
				return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
			}
			if (file.download_url) {
				const response = await fetch(file.download_url);
				if (!response.ok) {
					throw new Error(`Failed to download file contents: ${response.status} ${response.statusText}`);
				}
				return await response.text();
			}
			throw new Error("GitHub did not return readable file contents.");
		});
		repoFileCache.set(key, cached);
	}
	return cached;
}

export async function getRepoCommitSha(repo: GitHubRepo, ref: string): Promise<string> {
	const key = `${repoKey(repo)}@${ref}`;
	let cached = repoCommitCache.get(key);
	if (!cached) {
		cached = fetchRepoCommitSha(repo, ref);
		repoCommitCache.set(key, cached);
	}
	return cached;
}

export async function fetchRepoCommitSha(repo: GitHubRepo, ref: string): Promise<string> {
	const commit = await githubJson<GitHubCommitResponse>(`/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}`);
	await writeRepoRefCache(repo, ref, commit.sha);
	repoCommitCache.set(`${repoKey(repo)}@${ref}`, Promise.resolve(commit.sha));
	return commit.sha;
}
