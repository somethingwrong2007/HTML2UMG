// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"

/**
 * One conversion request: design.html -> layout.json.
 *
 * The converter is an out-of-process Node CLI (Resources/Converter/cli/convert.js)
 * so the editor needs no Node binding and no install step beyond Node itself.
 */
struct HTML2UMG_API FH2UConvertOptions
{
	/** Path to the source .html (absolute). */
	FString HtmlFile;

	/** Path the converter should write. Empty = "<ProjectSaved>/Html2UMG/<HtmlBaseName>.json". */
	FString JsonFile;

	/** Layout viewport handed to the converter as --viewport WxH. */
	FVector2D Viewport = FVector2D(1920.0f, 1080.0f);

	/** Optional extra viewports for anchor probing, handed over as --probe WxH,WxH. */
	TArray<FVector2D> Probes;

	/** Baked into the layout json as its target blueprint (--blueprint). Content path, e.g. /Game/UI/WBP_Design. */
	FString BlueprintPath;

	/** Ask the converter to exit non-zero when the design produced warnings (--strict). */
	bool bStrict = false;

	/** Hard wall-clock limit for the node subprocess. */
	int32 TimeoutSeconds = 30;

	/** Override for the node executable. Empty = auto-detect (HTML2UMG_NODE, PATH, common install dirs). */
	FString NodeExecutable;

	/** Override for convert.js. Empty = <PluginBaseDir>/Resources/Converter/cli/convert.js. */
	FString ConverterScript;

	/** Working directory for the subprocess. Empty = the directory the html lives in. */
	FString WorkingDirectory;

	/** Raw extra command line appended verbatim (advanced / debugging). */
	FString ExtraArguments;

	FString GetEffectiveJsonFile() const;
	FString GetEffectiveWorkingDirectory() const;
};

/** Outcome of one converter run. Always fully populated, even on failure. */
struct HTML2UMG_API FH2UConvertResult
{
	bool bSuccess = false;
	int32 ExitCode = INDEX_NONE;
	FString StdOut;
	FString StdErr;
	/** Set only when bSuccess. */
	FString JsonPath;
	/** Human readable failure reason (node missing, script missing, timeout, non-zero exit...). */
	FString Error;
	double ElapsedSeconds = 0.0;

	/** Multi-line report for logs / the panel. */
	FString ToText() const;
};

/**
 * Drives the Node converter. Everything here is blocking and must NOT run on the
 * game thread - the panel wraps it in Async(EAsyncExecution::ThreadPool).
 */
class HTML2UMG_API FHtml2UMGConverter
{
public:
	/** Runs the converter. Returns OutResult.bSuccess. Never throws. */
	static bool ConvertHtmlToLayout(const FH2UConvertOptions& Options, FH2UConvertResult& OutResult);

	/**
	 * Locates node.exe: %HTML2UMG_NODE% -> `where node` -> PATH scan -> common install dirs.
	 * Returns an empty string and fills OutError when nothing usable was found.
	 */
	static FString FindNodeExecutable(FString& OutError);

	/** Full path to Resources/Converter/cli/convert.js, or empty when the plugin/script is missing. */
	static FString FindConverterScript();

	/** <ProjectSaved>/Html2UMG, created on demand. */
	static FString GetWorkDirectory();

	/** Default json destination for an html input. */
	static FString MakeDefaultJsonPath(const FString& HtmlFile);

	/** Version string of the located node ("v22.11.0"), or empty. */
	static FString QueryNodeVersion(const FString& NodeExecutable);

private:
	/** Launches Exe/Arguments, drains stdout+stderr until exit or timeout. */
	static bool RunProcessWithPipes(
		const FString& Executable,
		const FString& Arguments,
		const FString& WorkingDirectory,
		int32 TimeoutSeconds,
		FString& OutStdOut,
		FString& OutStdErr,
		int32& OutExitCode,
		double& OutElapsedSeconds,
		bool& bOutTimedOut,
		FString& OutError);

	/** Quotes one command line argument for CreateProc. */
	static FString QuotedArg(const FString& InArg);
};
