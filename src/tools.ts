import { createReadToolDefinition, defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_FIND_LIMIT, DEFAULT_GREP_LIMIT, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, DEFAULT_REPO_READ_LIMIT } from "./constants.ts";
import {
	assertDirectoryPath,
	compareCaseInsensitive,
	createGlobMatcher,
	encodePath,
	formatDirectoryListOutput,
	formatNumber,
	formatPathListOutput,
	formatReadOutput,
	getCachedRepoState,
	getRepoCommitSha,
	getRepoFileText,
	getRepoStateWithSnapshot,
	getRepoTree,
	githubJson,
	grepRepoSnapshot,
	grepRepoViaGitHubRest,
	isUnderPath,
	listRepoSnapshot,
	normalizeRepoPath,
	parseRepoInput,
	prefetchRepoSnapshot,
	refreshCachedRepoStateInBackground,
	relativeToPath,
	resolveGrepTarget,
	resolveRepoRef,
	stripUndefined,
	validateGrepPattern,
	type GitHubContentFile,
	type GitHubContentObject,
	type GitHubContentsDirectory,
	type GitHubRepoSearchResponse,
} from "./backend.ts";
import {
	formatCompactTextResult,
	formatRepoFindCall,
	formatRepoFindFilesCall,
	formatRepoGrepCall,
	formatRepoGrepResult,
	formatRepoListCall,
	formatRepoReadCall,
	formatRepoReadResult,
	getDetails,
	renderText,
} from "./render.ts";

const repoFindTool = defineTool({
	name: "repo_find",
	label: "Repo Find",
	description: "Find GitHub repositories by query.",
	promptSnippet: "Find candidate GitHub repositories for a library, tool, or codebase.",
	promptGuidelines: ["Use this tool when the user wants to discover a GitHub repository to inspect."],
	parameters: Type.Object({
		query: Type.String({ description: "Repository search query." }),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Maximum number of repositories." })),
	}),
	async execute(_toolCallId, params) {
		const searchParams = new URLSearchParams({
			q: params.query,
			per_page: String(params.limit ?? 5),
			sort: "stars",
			order: "desc",
		});
		const response = await githubJson<GitHubRepoSearchResponse>(`/search/repositories?${searchParams.toString()}`);
		const lines = response.items.map((item, index) => {
			const description = item.description ? ` — ${item.description}` : "";
			return `${index + 1}. ${item.full_name} (${formatNumber(item.stargazers_count)} stars)${description}\n   ${item.html_url}`;
		});
		return {
			content: [{ type: "text", text: lines.length > 0 ? lines.join("\n\n") : "No repositories found." }],
			details: { backend: "github-rest", count: response.items.length },
		};
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoFindCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatCompactTextResult(result, options, theme, 10));
	},
});

const repoListTool = defineTool({
	name: "repo_list",
	label: "Repo List",
	description: "List one directory in a remote GitHub repository, like local ls.",
	promptSnippet: "List one remote GitHub directory like a local ls call.",
	promptGuidelines: [
		"Use this tool instead of fetching GitHub HTML when you need to inspect a repository directory.",
		"Omit path to list the repo root, then call repo_list again for specific subdirectories as needed.",
	],
	parameters: Type.Object({
		repo: Type.String({ description: "Repository as owner/name or GitHub URL." }),
		ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA." })),
		path: Type.Optional(Type.String({ description: "Directory path inside the repository. Omit for the root directory." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5000, description: "Maximum number of entries to return." })),
	}),
	async execute(_toolCallId, params) {
		const repo = parseRepoInput(params.repo);
		const path = normalizeRepoPath(params.path);
		const cachedState = await getCachedRepoState(repo, params.ref);
		if (cachedState) {
			refreshCachedRepoStateInBackground(repo, cachedState);
			return await listRepoSnapshot(cachedState, path, params.limit);
		}

		const resolvedRef = await resolveRepoRef(repo, params.ref);
		prefetchRepoSnapshot(repo, resolvedRef);
		const refQuery = params.ref ? `?ref=${encodeURIComponent(params.ref)}` : "";
		const encodedPath = path ? `/${encodePath(path)}` : "";
		const result = await githubJson<GitHubContentsDirectory | GitHubContentObject>(
			`/repos/${repo.owner}/${repo.name}/contents${encodedPath}${refQuery}`,
			"application/vnd.github.object+json",
		);
		const asFile = result as Partial<GitHubContentFile>;
		if (asFile.type === "file") {
			throw new Error(`${path || "/"} is a file. Use repo_read instead.`);
		}
		const entries = (Array.isArray(result) ? result : result.entries ?? []).slice();
		const output = formatDirectoryListOutput(entries, params.limit);
		return {
			content: [{ type: "text", text: output.text }],
			details: stripUndefined({
				backend: "github-rest",
				path: path || "/",
				ref: resolvedRef,
				count: output.count,
				entryLimitReached: output.entryLimitReached,
				truncation: output.truncation,
			}),
		};
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoListCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatCompactTextResult(result, options, theme, 20, "entryLimitReached", "entries"));
	},
});

const repoReadTool = defineTool({
	name: "repo_read",
	label: "Repo Read",
	description: `Read a file from a remote GitHub repository, like local read. Uses a cached archive when possible. Defaults to ${DEFAULT_REPO_READ_LIMIT} lines; use offset/limit to continue or request a different range. Text output is still capped at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
	promptSnippet: "Read a file from a remote GitHub repository like a local file read.",
	promptGuidelines: ["Use this tool when you know the repository file path you want to inspect."],
	parameters: Type.Object({
		repo: Type.String({ description: "Repository as owner/name or GitHub URL." }),
		path: Type.String({ description: "File path inside the repository." }),
		ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA." })),
		offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)." })),
		limit: Type.Optional(Type.Number({ description: `Maximum number of lines to read (default: ${DEFAULT_REPO_READ_LIMIT}).` })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		const repo = parseRepoInput(params.repo);
		const path = normalizeRepoPath(params.path);
		if (!path) throw new Error("path is required");
		const effectiveLimit = params.limit ?? DEFAULT_REPO_READ_LIMIT;
		let state = await getCachedRepoState(repo, params.ref);
		try {
			if (!state) {
				onUpdate?.({ content: [{ type: "text", text: "Preparing cached GitHub archive..." }], details: {} });
				state = await getRepoStateWithSnapshot(repo, params.ref, signal);
			} else {
				refreshCachedRepoStateInBackground(repo, state);
			}
			const readTool = createReadToolDefinition(state.snapshot.path);
			const result = await readTool.execute(
				toolCallId,
				{ path, offset: params.offset, limit: effectiveLimit },
				signal,
				onUpdate,
				ctx,
			);
			return {
				...result,
				details: stripUndefined({
					...getDetails(result),
					backend: "github-archive-cache",
					path,
					ref: state.ref,
					commit: state.commit,
				}),
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			const fallbackReason = error instanceof Error ? error.message : String(error);
			onUpdate?.({ content: [{ type: "text", text: "Cached archive unavailable; falling back to GitHub REST file read..." }], details: {} });
			const resolvedRef = state?.ref ?? await resolveRepoRef(repo, params.ref);
			prefetchRepoSnapshot(repo, resolvedRef);
			const text = await getRepoFileText(repo, resolvedRef, path);
			const output = formatReadOutput(text, params.offset, effectiveLimit);
			return {
				content: [{ type: "text", text: output.text }],
				details: stripUndefined({ backend: "github-rest", path, ref: resolvedRef, truncation: output.truncation, fallbackReason }),
			};
		}
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoReadCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatRepoReadResult(context.args, result, options, theme));
	},
});

const repoFindFilesTool = defineTool({
	name: "repo_find_files",
	label: "Repo Find Files",
	description: "Find files in a remote GitHub repository by glob pattern, like local find.",
	promptSnippet: "Find remote repository files by glob pattern like a local find call.",
	promptGuidelines: [
		"Use this tool when you need to discover files by pattern inside a remote repository.",
		"Use repo_list for one directory and repo_find_files for recursive file discovery.",
	],
	parameters: Type.Object({
		repo: Type.String({ description: "Repository as owner/name or GitHub URL." }),
		pattern: Type.String({ description: "Glob pattern to match files, for example *.ts or **/*.test.ts." }),
		ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA." })),
		path: Type.Optional(Type.String({ description: "Directory to search in (default: repo root)." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5000, description: "Maximum number of results to return." })),
	}),
	async execute(_toolCallId, params) {
		const repo = parseRepoInput(params.repo);
		const cachedState = await getCachedRepoState(repo, params.ref);
		const ref = cachedState?.ref ?? await resolveRepoRef(repo, params.ref);
		if (cachedState) refreshCachedRepoStateInBackground(repo, cachedState);
		else prefetchRepoSnapshot(repo, ref);
		const tree = cachedState?.tree ?? (await getRepoTree(repo, ref)).tree;
		const searchPath = normalizeRepoPath(params.path);
		assertDirectoryPath(tree, searchPath);
		const matcher = createGlobMatcher(params.pattern);
		const effectiveLimit = params.limit ?? DEFAULT_FIND_LIMIT;
		const matches = tree.tree
			.filter(entry => entry.type === "blob")
			.filter(entry => isUnderPath(entry.path, searchPath))
			.map(entry => relativeToPath(entry.path, searchPath))
			.filter(candidate => matcher(candidate))
			.sort(compareCaseInsensitive);
		if (matches.length === 0) {
			return {
				content: [{ type: "text", text: "No files found matching pattern" }],
				details: { backend: cachedState ? "github-archive-cache" : "github-rest", path: searchPath || "/", ref, ...(cachedState ? { commit: cachedState.commit } : {}) },
			};
		}
		const output = formatPathListOutput(matches, effectiveLimit);
		return {
			content: [{ type: "text", text: output.text }],
			details: stripUndefined({
				backend: cachedState ? "github-archive-cache" : "github-rest",
				path: searchPath || "/",
				ref,
				count: output.count,
				commit: cachedState?.commit,
				resultLimitReached: output.resultLimitReached,
				truncation: output.truncation,
			}),
		};
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoFindFilesCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatCompactTextResult(result, options, theme, 20, "resultLimitReached", "results"));
	},
});

const repoGrepTool = defineTool({
	name: "repo_grep",
	label: "Repo Grep",
	description: "Search file contents inside a remote GitHub repository using a cached archive and local grep when possible.",
	promptSnippet: "Search remote repository file contents by pattern like a local grep call.",
	promptGuidelines: [
		"Use this tool to search remote repository contents instead of GitHub HTML or broad web search.",
		"Use path to scope to one file or directory, and use glob to narrow which files are scanned.",
	],
	parameters: Type.Object({
		repo: Type.String({ description: "Repository as owner/name or GitHub URL." }),
		pattern: Type.String({ description: "Search pattern (regex or literal string)." }),
		ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA." })),
		path: Type.Optional(Type.String({ description: "Directory or file to search (default: repo root)." })),
		glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, for example *.ts or **/*.spec.ts." })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)." })),
		context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000, description: "Maximum number of matches to return." })),
	}),
	async execute(_toolCallId, params, signal, onUpdate) {
		const repo = parseRepoInput(params.repo);
		validateGrepPattern(params.pattern, Boolean(params.literal), Boolean(params.ignoreCase));
		const cachedState = await getCachedRepoState(repo, params.ref);
		let state = cachedState;
		try {
			if (!state) {
				onUpdate?.({ content: [{ type: "text", text: "Preparing cached GitHub archive..." }], details: {} });
				state = await getRepoStateWithSnapshot(repo, params.ref, signal);
			} else {
				refreshCachedRepoStateInBackground(repo, state);
			}
			const normalizedPath = normalizeRepoPath(params.path);
			const grepTarget = resolveGrepTarget(state.tree, normalizedPath);
			const fileMatcher = params.glob ? createGlobMatcher(params.glob) : null;
			const filesToScan = grepTarget.files
				.filter(filePath => !fileMatcher || fileMatcher(relativeToPath(filePath, grepTarget.filterBase)))
				.sort(compareCaseInsensitive);
			const result = await grepRepoSnapshot(state.snapshot, params, grepTarget, filesToScan, signal);
			return {
				content: [{ type: "text", text: result.output }],
				details: stripUndefined({
					backend: result.backend,
					path: normalizedPath || "/",
					ref: state.ref,
					commit: state.commit,
					matches: result.matchCount,
					cachePath: result.cachePath,
					matchLimitReached: result.matchLimitReached,
					truncation: result.truncation,
					linesTruncated: result.linesTruncated,
					fallbackReason: result.fallbackReason,
				}),
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			const fallbackReason = error instanceof Error ? error.message : String(error);
			onUpdate?.({ content: [{ type: "text", text: "Cached archive unavailable; falling back to GitHub REST scan..." }], details: {} });
			const requestedRef = state?.ref ?? await resolveRepoRef(repo, params.ref);
			const commitSha = state?.commit ?? await getRepoCommitSha(repo, requestedRef);
			const { tree } = state ?? await getRepoTree(repo, commitSha);
			const normalizedPath = normalizeRepoPath(params.path);
			const grepTarget = resolveGrepTarget(tree, normalizedPath);
			const fileMatcher = params.glob ? createGlobMatcher(params.glob) : null;
			const filesToScan = grepTarget.files
				.filter(filePath => !fileMatcher || fileMatcher(relativeToPath(filePath, grepTarget.filterBase)))
				.sort(compareCaseInsensitive);
			return await grepRepoViaGitHubRest(repo, commitSha, normalizedPath, grepTarget, filesToScan, params, fallbackReason);
		}
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoGrepCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatRepoGrepResult(result, options, theme));
	},
});

export function registerRepoTools(pi: ExtensionAPI) {
	pi.registerTool(repoFindTool);
	pi.registerTool(repoListTool);
	pi.registerTool(repoReadTool);
	pi.registerTool(repoFindFilesTool);
	pi.registerTool(repoGrepTool);
}
