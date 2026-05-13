import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
	DEFAULT_FIND_LIMIT,
	DEFAULT_GREP_LIMIT,
	DEFAULT_LIST_LIMIT,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DEFAULT_REF_REFRESH_MS,
	GITHUB_API_URL,
	GITHUB_API_VERSION,
	GREP_MAX_LINE_LENGTH,
	REPO_CACHE_COMPLETE_MARKER,
	REPO_METADATA_FILE,
	REPO_REFS_DIR,
	REPO_TREES_DIR,
	RIPGREP_CHUNK_SIZE,
	RIPGREP_MAX_ARG_BYTES,
} from "./constants.ts";

const execFileAsync = promisify(execFile);

const repoMetadataCache = new Map<string, Promise<GitHubRepoMetadata>>();
const repoTreeCache = new Map<string, Promise<{ ref: string; tree: GitHubTreeResponse }>>();
const repoFileCache = new Map<string, Promise<string>>();
const repoCommitCache = new Map<string, Promise<string>>();
const repoSnapshotCache = new Map<string, Promise<RepoSnapshot>>();
let cachedGitHubToken: Promise<string | null> | null = null;
let cachedRipgrepAvailable: Promise<boolean> | null = null;

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

export async function getCachedRepoState(repo: GitHubRepo, ref?: string): Promise<CachedRepoState | null> {
	const requestedRef = ref?.trim() || (await readRepoMetadataCache(repo))?.defaultBranch;
	if (!requestedRef) return null;
	const refCache = looksLikeCommitSha(requestedRef) ? null : await readRepoRefCache(repo, requestedRef);
	const commit = looksLikeCommitSha(requestedRef) ? requestedRef : refCache?.commit;
	if (!commit) return null;
	const snapshotPath = getRepoSnapshotPath(repo, commit);
	if (!(await pathExists(join(snapshotPath, REPO_CACHE_COMPLETE_MARKER)))) return null;
	const tree = await getOrCreateSnapshotTree(repo, commit, snapshotPath);
	return {
		ref: requestedRef,
		commit,
		tree,
		snapshot: { path: snapshotPath, commit },
		refUpdatedAt: refCache?.updatedAt ?? 0,
	};
}

export async function getRepoStateWithSnapshot(repo: GitHubRepo, ref?: string, signal?: AbortSignal): Promise<CachedRepoState> {
	const cachedState = await getCachedRepoState(repo, ref);
	if (cachedState) return cachedState;
	const requestedRef = await resolveRepoRef(repo, ref);
	const commit = await getRepoCommitSha(repo, requestedRef);
	const snapshot = await getRepoSnapshot(repo, commit, signal);
	const tree = await getOrCreateSnapshotTree(repo, commit, snapshot.path);
	return { ref: requestedRef, commit, tree, snapshot, refUpdatedAt: Date.now() };
}

export function prefetchRepoSnapshot(repo: GitHubRepo, ref?: string, options: { forceRefresh?: boolean } = {}): void {
	void (async () => {
		const requestedRef = await resolveRepoRef(repo, ref);
		const commit = options.forceRefresh ? await fetchRepoCommitSha(repo, requestedRef) : await getRepoCommitSha(repo, requestedRef);
		const snapshot = await getRepoSnapshot(repo, commit);
		await getOrCreateSnapshotTree(repo, commit, snapshot.path);
	})().catch(() => undefined);
}

export function refreshCachedRepoStateInBackground(repo: GitHubRepo, state: CachedRepoState): void {
	if (looksLikeCommitSha(state.ref)) return;
	if (Date.now() - state.refUpdatedAt < getRefRefreshMs()) return;
	prefetchRepoSnapshot(repo, state.ref, { forceRefresh: true });
}

export async function listRepoSnapshot(
	state: CachedRepoState,
	path: string,
	limit?: number,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	const target = resolveSnapshotPath(state.snapshot.path, path);
	const stats = await lstat(target);
	if (stats.isFile()) throw new Error(`${path || "/"} is a file. Use repo_read instead.`);
	if (!stats.isDirectory()) throw new Error(`Not a directory: ${path || "/"}`);
	const entries = (await readdir(target, { withFileTypes: true }))
		.filter(entry => !(path === "" && entry.name === REPO_CACHE_COMPLETE_MARKER))
		.map(entry => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }));
	const output = formatDirectoryListOutput(entries, limit);
	return {
		content: [{ type: "text", text: output.text }],
		details: stripUndefined({
			backend: "github-archive-cache",
			path: path || "/",
			ref: state.ref,
			commit: state.commit,
			count: output.count,
			entryLimitReached: output.entryLimitReached,
			truncation: output.truncation,
		}),
	};
}

export function formatDirectoryListOutput(
	entries: Array<{ name: string; type: string }>,
	limit?: number,
): { text: string; count: number; entryLimitReached?: number; truncation?: TruncationResult } {
	entries.sort((left, right) => compareCaseInsensitive(left.name, right.name));
	const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
	const entryLimitReached = entries.length > effectiveLimit;
	const selected = entries.slice(0, effectiveLimit);
	if (selected.length === 0) return { text: "(empty directory)", count: 0 };
	let output = selected.map(formatListEntry).join("\n");
	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
	}
	const truncation = truncateHead(output, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_BYTES);
	output = truncation.content;
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return stripUndefined({
		text: output,
		count: selected.length,
		entryLimitReached: entryLimitReached ? effectiveLimit : undefined,
		truncation: truncation.truncated ? truncation : undefined,
	});
}

export function formatPathListOutput(
	matches: string[],
	effectiveLimit: number,
): { text: string; count: number; resultLimitReached?: number; truncation?: TruncationResult } {
	const resultLimitReached = matches.length > effectiveLimit;
	const selected = matches.slice(0, effectiveLimit);
	let output = selected.join("\n");
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more`);
	}
	const truncation = truncateHead(output, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_BYTES);
	output = truncation.content;
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return stripUndefined({
		text: output,
		count: selected.length,
		resultLimitReached: resultLimitReached ? effectiveLimit : undefined,
		truncation: truncation.truncated ? truncation : undefined,
	});
}

export async function grepRepoSnapshot(
	snapshot: RepoSnapshot,
	params: RepoGrepParams,
	grepTarget: GrepTarget,
	filesToScan: string[],
	signal?: AbortSignal,
): Promise<RepoGrepResult> {
	const effectiveLimit = params.limit ?? DEFAULT_GREP_LIMIT;
	const contextValue = params.context && params.context > 0 ? params.context : 0;
	let fallbackReason: string | undefined;
	let search = await grepSnapshotWithRipgrep(snapshot, params, grepTarget, filesToScan, effectiveLimit, signal);
	if (!search) {
		fallbackReason = "ripgrep unavailable or could not run this pattern; used local JavaScript scan";
		search = await grepSnapshotWithJavaScript(snapshot, params, filesToScan, effectiveLimit);
	}
	const formatted = await formatSnapshotGrepOutput(snapshot.path, search.matches, grepTarget, contextValue);
	let output = formatted.output;
	const notices: string[] = [];
	if (search.matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
	}
	const truncation = truncateHead(output, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_BYTES);
	output = truncation.content;
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (formatted.linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use repo_read to see full lines`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return stripUndefined({
		backend: search.backend,
		output,
		matchCount: search.matches.length,
		cachePath: snapshot.path,
		matchLimitReached: search.matchLimitReached ? effectiveLimit : undefined,
		truncation: truncation.truncated ? truncation : undefined,
		linesTruncated: formatted.linesTruncated ? true : undefined,
		fallbackReason,
	});
}

export async function grepRepoViaGitHubRest(
	repo: GitHubRepo,
	ref: string,
	normalizedPath: string,
	grepTarget: GrepTarget,
	filesToScan: string[],
	params: RepoGrepParams,
	fallbackReason?: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	const effectiveLimit = params.limit ?? DEFAULT_GREP_LIMIT;
	const contextValue = params.context && params.context > 0 ? params.context : 0;
	const matchLine = createLineMatcher(params.pattern, Boolean(params.literal), Boolean(params.ignoreCase));
	const outputLines: string[] = [];
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;
	for (const filePath of filesToScan) {
		const fileText = await getRepoFileText(repo, ref, filePath);
		if (looksBinary(fileText)) continue;
		const lines = normalizeNewlines(fileText).split("\n");
		for (let index = 0; index < lines.length; index++) {
			if (!matchLine(lines[index])) continue;
			matchCount++;
			const displayPath = grepTarget.isDirectorySearch
				? relativeToPath(filePath, grepTarget.filterBase)
				: basenamePath(filePath);
			const start = contextValue > 0 ? Math.max(1, index + 1 - contextValue) : index + 1;
			const end = contextValue > 0 ? Math.min(lines.length, index + 1 + contextValue) : index + 1;
			for (let lineNo = start; lineNo <= end; lineNo++) {
				const text = truncateLine(lines[lineNo - 1] ?? "");
				if (text.wasTruncated) linesTruncated = true;
				if (lineNo === index + 1) outputLines.push(`${displayPath}:${lineNo}: ${text.text}`);
				else outputLines.push(`${displayPath}-${lineNo}- ${text.text}`);
			}
			if (matchCount >= effectiveLimit) {
				matchLimitReached = true;
				break;
			}
		}
		if (matchLimitReached) break;
	}
	if (matchCount === 0) {
		const noMatchText = fallbackReason ? `No matches found\n\n[Archive cache unavailable; used slower GitHub REST scan]` : "No matches found";
		return {
			content: [{ type: "text", text: noMatchText }],
			details: { backend: "github-rest", path: normalizedPath || "/", ref, matches: 0, ...(fallbackReason ? { fallbackReason } : {}) },
		};
	}
	let output = outputLines.join("\n");
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
	}
	const truncation = truncateHead(output, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_BYTES);
	output = truncation.content;
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use repo_read to see full lines`);
	}
	if (fallbackReason) {
		notices.push("Archive cache unavailable; used slower GitHub REST scan");
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return {
		content: [{ type: "text", text: output }],
		details: stripUndefined({
			backend: "github-rest",
			path: normalizedPath || "/",
			ref,
			matches: matchCount,
			matchLimitReached: matchLimitReached ? effectiveLimit : undefined,
			truncation: truncation.truncated ? truncation : undefined,
			linesTruncated: linesTruncated ? true : undefined,
			fallbackReason,
		}),
	};
}

export async function getRepoSnapshot(repo: GitHubRepo, commitSha: string, signal?: AbortSignal): Promise<RepoSnapshot> {
	const key = `${repoKey(repo)}@${commitSha}`;
	let cached = repoSnapshotCache.get(key);
	if (!cached) {
		cached = createRepoSnapshot(repo, commitSha, signal).catch(error => {
			repoSnapshotCache.delete(key);
			throw error;
		});
		repoSnapshotCache.set(key, cached);
	}
	return cached;
}

export async function getOrCreateSnapshotTree(repo: GitHubRepo, commitSha: string, snapshotPath: string): Promise<GitHubTreeResponse> {
	const cachedTree = await readRepoTreeCache(repo, commitSha);
	if (cachedTree) return cachedTree;
	const tree = await generateSnapshotTree(snapshotPath);
	await writeRepoTreeCache(repo, commitSha, tree);
	return tree;
}

export async function generateSnapshotTree(snapshotPath: string): Promise<GitHubTreeResponse> {
	const tree: GitHubTreeEntry[] = [];
	async function walk(directory: string, relativeDirectory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (!relativeDirectory && entry.name === REPO_CACHE_COMPLETE_MARKER) continue;
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				tree.push({ path: relativePath, type: "tree" });
				await walk(join(directory, entry.name), relativePath);
			} else {
				tree.push({ path: relativePath, type: "blob" });
			}
		}
	}
	await walk(snapshotPath, "");
	tree.sort((left, right) => compareCaseInsensitive(left.path, right.path));
	return { truncated: false, tree };
}

export async function createRepoSnapshot(repo: GitHubRepo, commitSha: string, signal?: AbortSignal): Promise<RepoSnapshot> {
	const cachePath = getRepoSnapshotPath(repo, commitSha);
	const markerPath = join(cachePath, REPO_CACHE_COMPLETE_MARKER);
	if (await pathExists(markerPath)) {
		return { path: cachePath, commit: commitSha };
	}
	await mkdir(dirname(cachePath), { recursive: true });
	if (await pathExists(cachePath)) {
		await rm(cachePath, { recursive: true, force: true });
	}
	const tempDir = await mkdtemp(join(dirname(cachePath), `.tmp-${commitSha}-`));
	const archivePath = join(tempDir, "repo.tar.gz");
	const extractPath = join(tempDir, "snapshot");
	try {
		await mkdir(extractPath, { recursive: true });
		await downloadRepoArchive(repo, commitSha, archivePath, signal);
		await execFileAsync("tar", ["-xzf", archivePath, "-C", extractPath, "--strip-components=1"]);
		await writeFile(join(extractPath, REPO_CACHE_COMPLETE_MARKER), commitSha, "utf8");
		try {
			await rename(extractPath, cachePath);
		} catch (error) {
			if (await pathExists(markerPath)) {
				const existingSnapshot = { path: cachePath, commit: commitSha };
				await getOrCreateSnapshotTree(repo, commitSha, existingSnapshot.path).catch(() => undefined);
				return existingSnapshot;
			}
			throw error;
		}
		const snapshot = { path: cachePath, commit: commitSha };
		await getOrCreateSnapshotTree(repo, commitSha, snapshot.path).catch(() => undefined);
		return snapshot;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export async function downloadRepoArchive(repo: GitHubRepo, ref: string, archivePath: string, signal?: AbortSignal): Promise<void> {
	const response = await githubFetch(
		`/repos/${repo.owner}/${repo.name}/tarball/${encodeURIComponent(ref)}`,
		"application/vnd.github+json",
		undefined,
		signal,
	);
	if (!response.body) throw new Error("GitHub archive response had no body.");
	await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archivePath));
}

export async function grepSnapshotWithRipgrep(
	snapshot: RepoSnapshot,
	params: RepoGrepParams,
	grepTarget: GrepTarget,
	filesToScan: string[],
	effectiveLimit: number,
	signal?: AbortSignal,
): Promise<SnapshotGrepSearch | null> {
	if (params.literal && params.pattern === "") return null;
	if (params.pattern.includes("\n") || params.pattern.includes("\r")) return null;
	if (!(await hasRipgrep())) return null;
	const filesToScanSet = new Set(filesToScan);
	const allMatches: GrepLineMatch[] = [];
	let matchLimitReached = false;
	const targetChunks = params.glob
		? chunkRipgrepPaths(filesToScan)
		: [[grepTarget.isDirectorySearch ? grepTarget.filterBase || "." : filesToScan[0]].filter(Boolean)];
	for (const targets of targetChunks) {
		if (targets.length === 0) continue;
		const result = await runRipgrepChunk(snapshot.path, params, targets, filesToScanSet, effectiveLimit - allMatches.length, signal);
		if (!result) return null;
		allMatches.push(...result.matches);
		if (result.matchLimitReached || allMatches.length >= effectiveLimit) {
			matchLimitReached = true;
			break;
		}
	}
	return { backend: "github-archive-rg", matches: dedupeMatches(allMatches), matchLimitReached };
}

export async function runRipgrepChunk(
	cwd: string,
	params: RepoGrepParams,
	targets: string[],
	filesToScanSet: Set<string>,
	remainingLimit: number,
	signal?: AbortSignal,
): Promise<{ matches: GrepLineMatch[]; matchLimitReached: boolean } | null> {
	if (remainingLimit <= 0) return { matches: [], matchLimitReached: true };
	const args = ["--json", "--line-number", "--color=never", "--no-heading", "--no-ignore", "--hidden"];
	if (params.literal) args.push("--fixed-strings");
	if (params.ignoreCase) args.push("--ignore-case");
	args.push("--", params.pattern, ...targets);
	return await new Promise((resolvePromise, reject) => {
		const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const matches: GrepLineMatch[] = [];
		let stdoutBuffer = "";
		let stderr = "";
		let matchLimitReached = false;
		const abortHandler = () => child.kill("SIGTERM");
		if (signal?.aborted) {
			child.kill("SIGTERM");
		} else {
			signal?.addEventListener("abort", abortHandler, { once: true });
		}
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", chunk => {
			stdoutBuffer += chunk;
			let newlineIndex = stdoutBuffer.indexOf("\n");
			while (newlineIndex >= 0) {
				const line = stdoutBuffer.slice(0, newlineIndex);
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				const match = parseRipgrepMatchLine(line, filesToScanSet);
				if (match) {
					matches.push(match);
					if (matches.length >= remainingLimit) {
						matchLimitReached = true;
						child.kill("SIGTERM");
						break;
					}
				}
				newlineIndex = stdoutBuffer.indexOf("\n");
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", chunk => {
			stderr += chunk;
			if (stderr.length > 4000) stderr = stderr.slice(-4000);
		});
		child.on("error", error => {
			signal?.removeEventListener("abort", abortHandler);
			if ((error as NodeJS.ErrnoException).code === "ENOENT") resolvePromise(null);
			else reject(error);
		});
		child.on("close", code => {
			signal?.removeEventListener("abort", abortHandler);
			if (signal?.aborted) {
				reject(new Error("repo_grep cancelled"));
				return;
			}
			if (matchLimitReached || code === 0 || code === 1) {
				resolvePromise({ matches, matchLimitReached });
				return;
			}
			resolvePromise(null);
		});
	});
}

export function parseRipgrepMatchLine(line: string, filesToScanSet: Set<string>): GrepLineMatch | null {
	if (!line.trim()) return null;
	let event: RipgrepJsonEvent;
	try {
		event = JSON.parse(line) as RipgrepJsonEvent;
	} catch {
		return null;
	}
	if (event.type !== "match") return null;
	const filePath = normalizeRipgrepPath(event.data?.path?.text ?? "");
	const lineNumber = event.data?.line_number;
	if (!filePath || typeof lineNumber !== "number") return null;
	if (!filesToScanSet.has(filePath)) return null;
	return { filePath, lineNumber };
}

export async function grepSnapshotWithJavaScript(
	snapshot: RepoSnapshot,
	params: RepoGrepParams,
	filesToScan: string[],
	effectiveLimit: number,
): Promise<SnapshotGrepSearch> {
	const matchLine = createLineMatcher(params.pattern, Boolean(params.literal), Boolean(params.ignoreCase));
	const matches: GrepLineMatch[] = [];
	let matchLimitReached = false;
	for (const filePath of filesToScan) {
		const fileText = await readSnapshotTextFile(snapshot.path, filePath);
		if (fileText === null || looksBinary(fileText)) continue;
		const lines = normalizeNewlines(fileText).split("\n");
		for (let index = 0; index < lines.length; index++) {
			if (!matchLine(lines[index])) continue;
			matches.push({ filePath, lineNumber: index + 1 });
			if (matches.length >= effectiveLimit) {
				matchLimitReached = true;
				break;
			}
		}
		if (matchLimitReached) break;
	}
	return { backend: "github-archive-js", matches, matchLimitReached };
}

export async function formatSnapshotGrepOutput(
	snapshotPath: string,
	matches: GrepLineMatch[],
	grepTarget: GrepTarget,
	contextValue: number,
): Promise<{ output: string; linesTruncated: boolean }> {
	if (matches.length === 0) return { output: "No matches found", linesTruncated: false };
	const outputLines: string[] = [];
	const fileCache = new Map<string, string[]>();
	let linesTruncated = false;
	for (const match of dedupeMatches(matches).sort(compareGrepLineMatches)) {
		let lines = fileCache.get(match.filePath);
		if (!lines) {
			const fileText = await readSnapshotTextFile(snapshotPath, match.filePath);
			if (fileText === null) continue;
			lines = normalizeNewlines(fileText).split("\n");
			fileCache.set(match.filePath, lines);
		}
		const displayPath = grepTarget.isDirectorySearch
			? relativeToPath(match.filePath, grepTarget.filterBase)
			: basenamePath(match.filePath);
		const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
		const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;
		for (let lineNo = start; lineNo <= end; lineNo++) {
			const text = truncateLine(lines[lineNo - 1] ?? "");
			if (text.wasTruncated) linesTruncated = true;
			if (lineNo === match.lineNumber) outputLines.push(`${displayPath}:${lineNo}: ${text.text}`);
			else outputLines.push(`${displayPath}-${lineNo}- ${text.text}`);
		}
	}
	return { output: outputLines.join("\n"), linesTruncated };
}

export function validateGrepPattern(pattern: string, literal: boolean, ignoreCase: boolean): void {
	if (!literal) createLineMatcher(pattern, false, ignoreCase);
}

export async function hasRipgrep(): Promise<boolean> {
	if (!cachedRipgrepAvailable) {
		cachedRipgrepAvailable = execFileAsync("rg", ["--version"])
			.then(() => true)
			.catch(() => false);
	}
	return cachedRipgrepAvailable;
}

export function chunkRipgrepPaths(paths: string[]): string[][] {
	const chunks: string[][] = [];
	let current: string[] = [];
	let currentBytes = 0;
	for (const path of paths) {
		const pathBytes = Buffer.byteLength(path, "utf8") + 1;
		if (current.length > 0 && (current.length >= RIPGREP_CHUNK_SIZE || currentBytes + pathBytes > RIPGREP_MAX_ARG_BYTES)) {
			chunks.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(path);
		currentBytes += pathBytes;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

export function dedupeMatches(matches: GrepLineMatch[]): GrepLineMatch[] {
	const seen = new Set<string>();
	const deduped: GrepLineMatch[] = [];
	for (const match of matches) {
		const key = `${match.filePath}:${match.lineNumber}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(match);
	}
	return deduped;
}

export function compareGrepLineMatches(left: GrepLineMatch, right: GrepLineMatch): number {
	const pathCompare = compareCaseInsensitive(left.filePath, right.filePath);
	return pathCompare || left.lineNumber - right.lineNumber;
}

export function normalizeRipgrepPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export async function readSnapshotTextFile(snapshotPath: string, repoPath: string): Promise<string | null> {
	const absolutePath = resolveSnapshotPath(snapshotPath, repoPath);
	const stats = await lstat(absolutePath);
	if (!stats.isFile()) return null;
	return await readFile(absolutePath, "utf8");
}

export function resolveSnapshotPath(snapshotPath: string, repoPath: string): string {
	const absoluteRoot = resolve(snapshotPath);
	const absolutePath = resolve(absoluteRoot, ...repoPath.split("/"));
	if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
		throw new Error(`Unsafe repository path: ${repoPath}`);
	}
	return absolutePath;
}

export async function readRepoMetadataCache(repo: GitHubRepo): Promise<RepoMetadataCache | null> {
	return await readJsonFile<RepoMetadataCache>(getRepoMetadataPath(repo));
}

export async function writeRepoMetadataCache(repo: GitHubRepo, defaultBranch: string): Promise<void> {
	await writeJsonFile(getRepoMetadataPath(repo), { defaultBranch, updatedAt: Date.now() });
}

export async function readRepoRefCache(repo: GitHubRepo, ref: string): Promise<RepoRefCache | null> {
	const cached = await readJsonFile<RepoRefCache>(getRepoRefCachePath(repo, ref));
	if (cached?.ref !== ref || !cached.commit) return null;
	return cached;
}

export async function writeRepoRefCache(repo: GitHubRepo, ref: string, commit: string): Promise<void> {
	await writeJsonFile(getRepoRefCachePath(repo, ref), { ref, commit, updatedAt: Date.now() });
}

export async function readRepoTreeCache(repo: GitHubRepo, commit: string): Promise<GitHubTreeResponse | null> {
	if (!looksLikeCommitSha(commit)) return null;
	const cached = await readJsonFile<RepoTreeCache>(getRepoTreeCachePath(repo, commit));
	if (cached?.commit !== commit || !Array.isArray(cached.tree?.tree)) return null;
	return cached.tree;
}

export async function writeRepoTreeCache(repo: GitHubRepo, commit: string, tree: GitHubTreeResponse): Promise<void> {
	if (!looksLikeCommitSha(commit)) return;
	await writeJsonFile(getRepoTreeCachePath(repo, commit), { commit, tree, updatedAt: Date.now() });
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return null;
	}
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value)}\n`, "utf8");
	await rename(tempPath, path);
}

export function getRepoSnapshotPath(repo: GitHubRepo, commitSha: string): string {
	return join(getRepoCacheBase(repo), commitSha);
}

export function getRepoMetadataPath(repo: GitHubRepo): string {
	return join(getRepoCacheBase(repo), REPO_METADATA_FILE);
}

export function getRepoRefCachePath(repo: GitHubRepo, ref: string): string {
	return join(getRepoCacheBase(repo), REPO_REFS_DIR, `${Buffer.from(ref).toString("base64url")}.json`);
}

export function getRepoTreeCachePath(repo: GitHubRepo, commit: string): string {
	return join(getRepoCacheBase(repo), REPO_TREES_DIR, `${commit}.json`);
}

export function getRepoCacheBase(repo: GitHubRepo): string {
	return join(getRepoCacheRoot(), "github", safeCacheSegment(repo.owner), safeCacheSegment(repo.name));
}

export function getRepoCacheRoot(): string {
	const configured = process.env.PI_REPOS_CACHE_DIR?.trim();
	if (!configured) return join(homedir(), ".cache", "pi-repos");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

export function getRefRefreshMs(): number {
	const value = Number(process.env.PI_REPOS_REF_REFRESH_MS);
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_REF_REFRESH_MS;
}

export function looksLikeCommitSha(value: string): boolean {
	return /^[0-9a-f]{40}$/i.test(value);
}

export function safeCacheSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function pathExists(path: string): Promise<boolean> {
	return access(path).then(() => true).catch(() => false);
}

export function normalizeRepoPath(path: string | undefined): string {
	return (path ?? "").replace(/^\/+|\/+$/g, "").trim();
}

export function encodePath(path: string): string {
	return normalizeRepoPath(path)
		.split("/")
		.filter(Boolean)
		.map(segment => encodeURIComponent(segment))
		.join("/");
}

export function formatListEntry(entry: { type: string; name: string }): string {
	return entry.type === "dir" ? `${entry.name}/` : entry.name;
}

export function compareCaseInsensitive(left: string, right: string): number {
	return left.toLowerCase().localeCompare(right.toLowerCase());
}

export function truncateHead(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): TruncationResult {
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = content.split("\n");
	const totalLines = lines.length;
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return { content, truncated: false, truncatedBy: null, totalLines, totalBytes, outputLines: totalLines, maxLines, maxBytes, firstLineExceedsLimit: false };
	}
	const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf8");
	if (firstLineBytes > maxBytes) {
		return { content: "", truncated: true, truncatedBy: "bytes", totalLines, totalBytes, outputLines: 0, maxLines, maxBytes, firstLineExceedsLimit: true };
	}
	const kept: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let index = 0; index < lines.length && index < maxLines; index++) {
		const line = lines[index];
		const lineBytes = Buffer.byteLength(line, "utf8") + (index > 0 ? 1 : 0);
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		kept.push(line);
		bytes += lineBytes;
	}
	if (kept.length >= maxLines && bytes <= maxBytes) truncatedBy = "lines";
	return {
		content: kept.join("\n"),
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: kept.length,
		maxLines,
		maxBytes,
		firstLineExceedsLimit: false,
	};
}

export function formatReadOutput(text: string, offset?: number, limit?: number): { text: string; truncation?: TruncationResult } {
	const allLines = normalizeNewlines(text).split("\n");
	const totalFileLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}
	let selected = allLines.slice(startLine).join("\n");
	let userLimitedLines: number | undefined;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selected = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	}
	const truncation = truncateHead(selected);
	if (truncation.firstLineExceedsLimit) {
		return {
			text: `[Line ${startLineDisplay} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Narrow with limit or offset.]`,
			truncation,
		};
	}
	if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		const suffix =
			truncation.truncatedBy === "lines"
				? `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
				: `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		return { text: `${truncation.content}\n\n${suffix}`, truncation };
	}
	if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		return { text: `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]` };
	}
	return { text: truncation.content };
}

export function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function assertDirectoryPath(tree: GitHubTreeResponse, searchPath: string): void {
	if (!searchPath) return;
	const exact = tree.tree.find(entry => entry.path === searchPath);
	if (exact?.type === "blob") {
		throw new Error(`Not a directory: ${searchPath}`);
	}
	if (exact?.type === "tree") return;
	const hasChildren = tree.tree.some(entry => entry.path.startsWith(`${searchPath}/`));
	if (!hasChildren) {
		throw new Error(`Path not found: ${searchPath}`);
	}
}

export function resolveGrepTarget(tree: GitHubTreeResponse, searchPath: string): GrepTarget {
	if (!searchPath) {
		return { files: tree.tree.filter(entry => entry.type === "blob").map(entry => entry.path), filterBase: "", isDirectorySearch: true };
	}
	const exact = tree.tree.find(entry => entry.path === searchPath);
	if (exact?.type === "blob") {
		return { files: [searchPath], filterBase: searchPath, isDirectorySearch: false };
	}
	assertDirectoryPath(tree, searchPath);
	return {
		files: tree.tree.filter(entry => entry.type === "blob" && isUnderPath(entry.path, searchPath)).map(entry => entry.path),
		filterBase: searchPath,
		isDirectorySearch: true,
	};
}

export function isUnderPath(candidate: string, searchPath: string): boolean {
	if (!searchPath) return true;
	return candidate.startsWith(`${searchPath}/`);
}

export function relativeToPath(candidate: string, searchPath: string): string {
	if (!searchPath) return candidate;
	if (candidate.startsWith(`${searchPath}/`)) return candidate.slice(searchPath.length + 1);
	return candidate;
}

export function basenamePath(candidate: string): string {
	const parts = candidate.split("/");
	return parts[parts.length - 1] || candidate;
}

export function createGlobMatcher(pattern: string): (candidate: string) => boolean {
	const regex = globToRegExp(normalizeNewlines(pattern.trim()).replace(/\\/g, "/"));
	return (candidate: string) => regex.test(candidate.replace(/\\/g, "/"));
}

export function globToRegExp(pattern: string): RegExp {
	let output = "^";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "*") {
			const next = pattern[index + 1];
			if (next === "*") {
				const after = pattern[index + 2];
				if (after === "/") {
					output += "(?:.*/)?";
					index += 2;
				} else {
					output += ".*";
					index += 1;
				}
			} else {
				output += "[^/]*";
			}
		} else if (char === "?") {
			output += "[^/]";
		} else {
			output += escapeRegExp(char);
		}
	}
	output += "$";
	return new RegExp(output);
}

export function createLineMatcher(pattern: string, literal: boolean, ignoreCase: boolean): (line: string) => boolean {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : "");
	return (line: string) => regex.test(line);
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function truncateLine(value: string): { text: string; wasTruncated: boolean } {
	if (value.length <= GREP_MAX_LINE_LENGTH) return { text: value, wasTruncated: false };
	return { text: `${value.slice(0, GREP_MAX_LINE_LENGTH - 1)}…`, wasTruncated: true };
}

export function looksBinary(text: string): boolean {
	return text.includes("\u0000");
}

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

export type GitHubRepo = { owner: string; name: string };

export type GitHubRepoMetadata = { default_branch: string };

export type GitHubCommitResponse = { sha: string };

export type RepoGrepParams = {
	repo: string;
	pattern: string;
	ref?: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
};

export type GrepTarget = { files: string[]; filterBase: string; isDirectorySearch: boolean };

export type RepoSnapshot = { path: string; commit: string };

export type CachedRepoState = {
	ref: string;
	commit: string;
	tree: GitHubTreeResponse;
	snapshot: RepoSnapshot;
	refUpdatedAt: number;
};

export type RepoMetadataCache = { defaultBranch: string; updatedAt: number };

export type RepoRefCache = { ref: string; commit: string; updatedAt: number };

export type RepoTreeCache = { commit: string; tree: GitHubTreeResponse; updatedAt: number };

export type GrepLineMatch = { filePath: string; lineNumber: number };

export type SnapshotGrepSearch = {
	backend: "github-archive-rg" | "github-archive-js";
	matches: GrepLineMatch[];
	matchLimitReached: boolean;
};

export type RepoGrepResult = {
	backend: "github-archive-rg" | "github-archive-js";
	output: string;
	matchCount: number;
	cachePath: string;
	matchLimitReached?: number;
	truncation?: TruncationResult;
	linesTruncated?: boolean;
	fallbackReason?: string;
};

export type RipgrepJsonEvent = {
	type?: string;
	data?: {
		path?: { text?: string };
		line_number?: number;
	};
};

export type GitHubRepoSearchResponse = {
	items: Array<{
		full_name: string;
		description: string | null;
		stargazers_count: number;
		html_url: string;
	}>;
};

export type GitHubContentsEntry = {
	type: string;
	path: string;
	name: string;
	size: number;
	html_url: string | null;
	download_url: string | null;
};

export type GitHubContentsDirectory = GitHubContentsEntry[];

export type GitHubContentObject = {
	type?: string;
	entries?: GitHubContentsEntry[];
	content?: string;
	encoding?: string;
	download_url?: string | null;
	name?: string;
	path?: string;
	size?: number;
};

export type GitHubContentFile = {
	type: "file";
	path: string;
	name: string;
	size: number;
	encoding?: string;
	content?: string;
	download_url: string | null;
};

export type GitHubTreeEntry = {
	path: string;
	type: "blob" | "tree" | "commit";
	size?: number;
};

export type GitHubTreeResponse = {
	truncated: boolean;
	tree: GitHubTreeEntry[];
};

export type TruncationResult = {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	maxLines: number;
	maxBytes: number;
	firstLineExceedsLimit: boolean;
};
