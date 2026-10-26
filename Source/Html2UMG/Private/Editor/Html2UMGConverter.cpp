// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Editor/Html2UMGConverter.h"

#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "Html2UMGLog.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Misc/StringBuilder.h"
#include "Containers/StringConv.h"

namespace
{
	/** Told to the user verbatim when no usable node.exe exists. */
	const TCHAR* NodeMissingMessage =
		TEXT("Node.js 22+ required, install from nodejs.org, or set HTML2UMG_NODE");

	/** Number of bytes drained per pipe poll. Zero means "nothing pending". */
	void DrainPipe(void* ReadPipe, TArray<uint8>& InOutBytes)
	{
		if (ReadPipe == nullptr)
		{
			return;
		}

		// ReadPipeToArray returns false when nothing is pending; loop for as long as
		// the child keeps producing, otherwise a fast writer can fill the OS buffer
		// and deadlock waiting for a reader.
		uint32 Guard = 0;
		for (;;)
		{
			TArray<uint8> Chunk;
			if (!FPlatformProcess::ReadPipeToArray(ReadPipe, Chunk) || Chunk.Num() == 0)
			{
				break;
			}
			InOutBytes.Append(Chunk);
			if (++Guard >= 1024)
			{
				break;
			}
		}
	}

	FString BytesToUtf8String(const TArray<uint8>& Bytes)
	{
		if (Bytes.Num() == 0)
		{
			return FString();
		}
		const FUTF8ToTCHAR Converter(reinterpret_cast<const ANSICHAR*>(Bytes.GetData()), Bytes.Num());
		return FString(Converter.Length(), Converter.Get());
	}

	bool IsRunnableFile(const FString& Path)
	{
		return !Path.IsEmpty() && IFileManager::Get().FileExists(*Path);
	}
}

FString FH2UConvertOptions::GetEffectiveJsonFile() const
{
	if (!JsonFile.IsEmpty())
	{
		return FPaths::ConvertRelativePathToFull(JsonFile);
	}
	return FHtml2UMGConverter::MakeDefaultJsonPath(HtmlFile);
}

FString FH2UConvertOptions::GetEffectiveWorkingDirectory() const
{
	if (!WorkingDirectory.IsEmpty())
	{
		return WorkingDirectory;
	}
	if (!HtmlFile.IsEmpty())
	{
		const FString HtmlDir = FPaths::GetPath(HtmlFile);
		if (!HtmlDir.IsEmpty())
		{
			return HtmlDir;
		}
	}
	return FPaths::ProjectDir();
}

FString FH2UConvertResult::ToText() const
{
	TStringBuilder<2048> Builder;
	Builder.Appendf(TEXT("%s in %.2fs (exit %d)\n"), bSuccess ? TEXT("converter OK") : TEXT("converter FAILED"), ElapsedSeconds, ExitCode);
	if (!Error.IsEmpty())
	{
		Builder.Appendf(TEXT("error: %s\n"), *Error);
	}
	if (!JsonPath.IsEmpty())
	{
		Builder.Appendf(TEXT("json:  %s\n"), *JsonPath);
	}
	if (!StdErr.IsEmpty())
	{
		Builder.Appendf(TEXT("stderr:\n%s\n"), *StdErr);
	}
	if (!StdOut.IsEmpty())
	{
		Builder.Appendf(TEXT("stdout:\n%s\n"), *StdOut);
	}
	return Builder.ToString();
}

FString FHtml2UMGConverter::GetWorkDirectory()
{
	const FString Dir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("Html2UMG"));
	IFileManager::Get().MakeDirectory(*Dir, true);
	return Dir;
}

FString FHtml2UMGConverter::MakeDefaultJsonPath(const FString& HtmlFile)
{
	FString BaseName = FPaths::GetBaseFilename(HtmlFile);
	if (BaseName.IsEmpty())
	{
		BaseName = TEXT("layout");
	}
	return FPaths::Combine(GetWorkDirectory(), BaseName + TEXT(".json"));
}

FString FHtml2UMGConverter::FindConverterScript()
{
	const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("Html2UMG"));
	if (!Plugin.IsValid())
	{
		return FString();
	}

	const FString Script = FPaths::ConvertRelativePathToFull(
		FPaths::Combine(Plugin->GetBaseDir(), TEXT("Resources"), TEXT("Converter"), TEXT("cli"), TEXT("convert.js")));
	return Script;
}

FString FHtml2UMGConverter::FindNodeExecutable(FString& OutError)
{
	OutError.Reset();

	// 1) explicit override
	FString EnvNode = FPlatformMisc::GetEnvironmentVariable(TEXT("HTML2UMG_NODE"));
	EnvNode.TrimStartAndEndInline();
	EnvNode.TrimQuotesInline();
	if (!EnvNode.IsEmpty())
	{
		const FString Resolved = FPaths::ConvertRelativePathToFull(EnvNode);
		if (IsRunnableFile(Resolved))
		{
			return Resolved;
		}

		// An override that does not exist is a hard error: silently falling through
		// to a different node would be worse than failing loudly.
		OutError = FString::Printf(TEXT("HTML2UMG_NODE points at '%s', which does not exist. %s"), *EnvNode, NodeMissingMessage);
		UE_LOG(LogHtml2UMG, Error, TEXT("%s"), *OutError);
		return FString();
	}

	// 2) `where node` - the launcher may be a shim (nvm-windows, fnm, volta), so we
	// take whatever the shell itself would resolve.
	{
		FString WhereOut;
		FString WhereErr;
		int32 WhereExit = INDEX_NONE;
		double UnusedElapsed = 0.0;
		bool bTimedOut = false;
		FString WhereFailure;
		if (RunProcessWithPipes(TEXT("where.exe"), TEXT("node"), FString(), 5, WhereOut, WhereErr, WhereExit, UnusedElapsed, bTimedOut, WhereFailure)
			&& WhereExit == 0)
		{
			TArray<FString> Lines;
			WhereOut.ParseIntoArrayLines(Lines, true);
			for (FString& Line : Lines)
			{
				Line.TrimStartAndEndInline();
				Line.TrimQuotesInline();
				if (IsRunnableFile(Line))
				{
					return FPaths::ConvertRelativePathToFull(Line);
				}
			}
		}
	}

	// 3) scan PATH ourselves (covers cases where `where` is unavailable/blocked)
	{
		TArray<FString> PathDirs;
		FPlatformMisc::GetEnvironmentVariable(TEXT("PATH")).ParseIntoArray(PathDirs, TEXT(";"), true);
		for (FString& Dir : PathDirs)
		{
			Dir.TrimStartAndEndInline();
			Dir.TrimQuotesInline();
			if (Dir.IsEmpty())
			{
				continue;
			}
			const FString Candidate = FPaths::ConvertRelativePathToFull(FPaths::Combine(Dir, TEXT("node.exe")));
			if (IsRunnableFile(Candidate))
			{
				return Candidate;
			}
		}
	}

	// 4) well-known install locations
	{
		TArray<FString> Candidates;
		const FString ProgramFiles = FPlatformMisc::GetEnvironmentVariable(TEXT("ProgramFiles"));
		const FString ProgramFilesX86 = FPlatformMisc::GetEnvironmentVariable(TEXT("ProgramFiles(x86)"));
		const FString LocalAppData = FPlatformMisc::GetEnvironmentVariable(TEXT("LOCALAPPDATA"));
		const FString UserProfile = FPlatformMisc::GetEnvironmentVariable(TEXT("USERPROFILE"));

		if (!ProgramFiles.IsEmpty())
		{
			Candidates.Add(FPaths::Combine(ProgramFiles, TEXT("nodejs"), TEXT("node.exe")));
		}
		if (!ProgramFilesX86.IsEmpty())
		{
			Candidates.Add(FPaths::Combine(ProgramFilesX86, TEXT("nodejs"), TEXT("node.exe")));
		}
		if (!LocalAppData.IsEmpty())
		{
			Candidates.Add(FPaths::Combine(LocalAppData, TEXT("Programs"), TEXT("nodejs"), TEXT("node.exe")));
		}
		if (!UserProfile.IsEmpty())
		{
			Candidates.Add(FPaths::Combine(UserProfile, TEXT("scoop"), TEXT("apps"), TEXT("nodejs"), TEXT("current"), TEXT("node.exe")));
			Candidates.Add(FPaths::Combine(UserProfile, TEXT("AppData"), TEXT("Roaming"), TEXT("nvm"), TEXT("node.exe")));
		}
		Candidates.Add(TEXT("C:/Program Files/nodejs/node.exe"));
		Candidates.Add(TEXT("C:/Program Files (x86)/nodejs/node.exe"));
		Candidates.Add(TEXT("C:/ProgramData/chocolatey/bin/node.exe"));
		Candidates.Add(TEXT("C:/nodejs/node.exe"));

		for (const FString& Candidate : Candidates)
		{
			if (IsRunnableFile(Candidate))
			{
				return FPaths::ConvertRelativePathToFull(Candidate);
			}
		}
	}

	OutError = NodeMissingMessage;
	UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG: no node.exe found. %s"), NodeMissingMessage);
	return FString();
}

FString FHtml2UMGConverter::QueryNodeVersion(const FString& NodeExecutable)
{
	if (NodeExecutable.IsEmpty())
	{
		return FString();
	}

	FString StdOut;
	FString StdErr;
	int32 ExitCode = INDEX_NONE;
	double Elapsed = 0.0;
	bool bTimedOut = false;
	FString Failure;
	if (RunProcessWithPipes(NodeExecutable, TEXT("--version"), FString(), 10, StdOut, StdErr, ExitCode, Elapsed, bTimedOut, Failure) && ExitCode == 0)
	{
		StdOut.TrimStartAndEndInline();
		return StdOut;
	}
	return FString();
}

FString FHtml2UMGConverter::QuotedArg(const FString& InArg)
{
	FString Clean = InArg;
	Clean.ReplaceInline(TEXT("\""), TEXT(""));
	return FString::Printf(TEXT("\"%s\""), *Clean);
}

bool FHtml2UMGConverter::RunProcessWithPipes(
	const FString& Executable,
	const FString& Arguments,
	const FString& WorkingDirectory,
	int32 TimeoutSeconds,
	FString& OutStdOut,
	FString& OutStdErr,
	int32& OutExitCode,
	double& OutElapsedSeconds,
	bool& bOutTimedOut,
	FString& OutError)
{
	OutStdOut.Reset();
	OutStdErr.Reset();
	OutExitCode = INDEX_NONE;
	OutElapsedSeconds = 0.0;
	bOutTimedOut = false;
	OutError.Reset();

	const double StartTime = FPlatformTime::Seconds();

	void* StdOutRead = nullptr;
	void* StdOutWrite = nullptr;
	void* StdErrRead = nullptr;
	void* StdErrWrite = nullptr;
	if (!FPlatformProcess::CreatePipe(StdOutRead, StdOutWrite))
	{
		OutError = TEXT("Could not create the stdout pipe for the converter process.");
		return false;
	}
	if (!FPlatformProcess::CreatePipe(StdErrRead, StdErrWrite))
	{
		FPlatformProcess::ClosePipe(StdOutRead, StdOutWrite);
		OutError = TEXT("Could not create the stderr pipe for the converter process.");
		return false;
	}

	uint32 ProcessID = 0;
	const TCHAR* WorkDirPtr = WorkingDirectory.IsEmpty() ? nullptr : *WorkingDirectory;
	FProcHandle ProcHandle = FPlatformProcess::CreateProc(
		*Executable,
		*Arguments,
		/*bLaunchDetached=*/ false,
		/*bLaunchHidden=*/ true,
		/*bLaunchReallyHidden=*/ true,
		&ProcessID,
		/*PriorityModifier=*/ 0,
		WorkDirPtr,
		/*PipeWriteChild=*/ StdOutWrite,
		/*PipeReadChild=*/ nullptr,
		/*PipeStdErrChild=*/ StdErrWrite);

	if (!ProcHandle.IsValid())
	{
		FPlatformProcess::ClosePipe(StdOutRead, StdOutWrite);
		FPlatformProcess::ClosePipe(StdErrRead, StdErrWrite);
		OutError = FString::Printf(TEXT("Failed to launch the converter process: %s %s"), *Executable, *Arguments);
		OutElapsedSeconds = FPlatformTime::Seconds() - StartTime;
		return false;
	}

	TArray<uint8> StdOutBytes;
	TArray<uint8> StdErrBytes;
	const double Timeout = static_cast<double>(FMath::Max(1, TimeoutSeconds));

	// Poll both pipes while the child is alive. Draining before every sleep keeps
	// the OS pipe buffers from filling up (a classic CreateProc deadlock).
	for (;;)
	{
		DrainPipe(StdOutRead, StdOutBytes);
		DrainPipe(StdErrRead, StdErrBytes);

		if (!FPlatformProcess::IsProcRunning(ProcHandle))
		{
			break;
		}

		if (FPlatformTime::Seconds() - StartTime > Timeout)
		{
			bOutTimedOut = true;
			break;
		}

		FPlatformProcess::Sleep(0.01f);
	}

	// Anything the child wrote just before exiting is still buffered.
	DrainPipe(StdOutRead, StdOutBytes);
	DrainPipe(StdErrRead, StdErrBytes);

	if (bOutTimedOut)
	{
		FPlatformProcess::TerminateProc(ProcHandle, /*KillTree=*/ true);
		FPlatformProcess::CloseProc(ProcHandle);
		FPlatformProcess::ClosePipe(StdOutRead, StdOutWrite);
		FPlatformProcess::ClosePipe(StdErrRead, StdErrWrite);

		OutStdOut = BytesToUtf8String(StdOutBytes);
		OutStdErr = BytesToUtf8String(StdErrBytes);
		OutElapsedSeconds = FPlatformTime::Seconds() - StartTime;
		OutError = FString::Printf(TEXT("Converter timed out after %d seconds and was terminated."), TimeoutSeconds);
		return false;
	}

	int32 ReturnCode = INDEX_NONE;
	FPlatformProcess::GetProcReturnCode(ProcHandle, &ReturnCode);
	FPlatformProcess::CloseProc(ProcHandle);
	FPlatformProcess::ClosePipe(StdOutRead, StdOutWrite);
	FPlatformProcess::ClosePipe(StdErrRead, StdErrWrite);

	OutStdOut = BytesToUtf8String(StdOutBytes);
	OutStdErr = BytesToUtf8String(StdErrBytes);
	OutExitCode = ReturnCode;
	OutElapsedSeconds = FPlatformTime::Seconds() - StartTime;
	return true;
}

bool FHtml2UMGConverter::ConvertHtmlToLayout(const FH2UConvertOptions& InOptions, FH2UConvertResult& OutResult)
{
	OutResult = FH2UConvertResult();
	const double StartTime = FPlatformTime::Seconds();

	// Every early exit records the elapsed time so the caller can log it uniformly.
	auto Fail = [&OutResult, StartTime](const FString& InMessage) -> bool
	{
		OutResult.bSuccess = false;
		OutResult.Error = InMessage;
		OutResult.ElapsedSeconds = FPlatformTime::Seconds() - StartTime;
		UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG converter: %s"), *InMessage);
		return false;
	};

	FH2UConvertOptions Options = InOptions;
	if (Options.HtmlFile.IsEmpty())
	{
		return Fail(TEXT("No HTML file was given to the converter."));
	}

	Options.HtmlFile = FPaths::ConvertRelativePathToFull(Options.HtmlFile);
	FPaths::NormalizeFilename(Options.HtmlFile);
	if (!IFileManager::Get().FileExists(*Options.HtmlFile))
	{
		return Fail(FString::Printf(TEXT("HTML file not found: %s"), *Options.HtmlFile));
	}

	FString NodeExecutable = Options.NodeExecutable;
	if (NodeExecutable.IsEmpty())
	{
		FString LookupError;
		NodeExecutable = FindNodeExecutable(LookupError);
		if (NodeExecutable.IsEmpty())
		{
			return Fail(LookupError.IsEmpty() ? FString(NodeMissingMessage) : LookupError);
		}
	}
	else if (!IsRunnableFile(NodeExecutable))
	{
		return Fail(FString::Printf(TEXT("The configured node executable does not exist: %s. %s"), *NodeExecutable, NodeMissingMessage));
	}

	FString ConverterScript = Options.ConverterScript;
	if (ConverterScript.IsEmpty())
	{
		ConverterScript = FindConverterScript();
	}
	if (ConverterScript.IsEmpty())
	{
		return Fail(TEXT("The Html2UMG plugin could not be located, so the converter CLI is unavailable. "
			"Expected it at <PluginBaseDir>/Resources/Converter/cli/convert.js."));
	}
	if (!IFileManager::Get().FileExists(*ConverterScript))
	{
		return Fail(FString::Printf(
			TEXT("Converter CLI not found at '%s'. The Html2UMG converter (Resources/Converter/cli/convert.js) is missing."),
			*ConverterScript));
	}

	const FString JsonFile = Options.GetEffectiveJsonFile();
	const FString JsonDir = FPaths::GetPath(JsonFile);
	if (!JsonDir.IsEmpty())
	{
		IFileManager::Get().MakeDirectory(*JsonDir, true);
	}

	const int32 ViewportWidth = FMath::Max(64, FMath::RoundToInt32(Options.Viewport.X));
	const int32 ViewportHeight = FMath::Max(64, FMath::RoundToInt32(Options.Viewport.Y));

	FString Arguments = FString::Printf(TEXT("%s %s -o %s --viewport %dx%d"),
		*QuotedArg(ConverterScript),
		*QuotedArg(Options.HtmlFile),
		*QuotedArg(JsonFile),
		ViewportWidth,
		ViewportHeight);

	if (Options.Probes.Num() > 0)
	{
		FString ProbeList;
		for (const FVector2D& Probe : Options.Probes)
		{
			if (!ProbeList.IsEmpty())
			{
				ProbeList += TEXT(",");
			}
			ProbeList += FString::Printf(TEXT("%dx%d"),
				FMath::Max(64, FMath::RoundToInt32(Probe.X)),
				FMath::Max(64, FMath::RoundToInt32(Probe.Y)));
		}
		if (!ProbeList.IsEmpty())
		{
			Arguments += FString::Printf(TEXT(" --probe %s"), *ProbeList);
		}
	}

	if (!Options.BlueprintPath.IsEmpty())
	{
		Arguments += FString::Printf(TEXT(" --blueprint %s"), *QuotedArg(Options.BlueprintPath));
	}

	if (Options.bStrict)
	{
		Arguments += TEXT(" --strict");
	}

	if (!Options.ExtraArguments.IsEmpty())
	{
		Arguments += TEXT(" ") + Options.ExtraArguments;
	}

	FString StdOut;
	FString StdErr;
	int32 ExitCode = INDEX_NONE;
	double Elapsed = 0.0;
	bool bTimedOut = false;
	FString RunError;

	UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG converter: running '%s %s'"), *NodeExecutable, *Arguments);

	const bool bLaunched = RunProcessWithPipes(
		NodeExecutable,
		Arguments,
		Options.GetEffectiveWorkingDirectory(),
		Options.TimeoutSeconds,
		StdOut,
		StdErr,
		ExitCode,
		Elapsed,
		bTimedOut,
		RunError);

	OutResult.StdOut = StdOut;
	OutResult.StdErr = StdErr;
	OutResult.ExitCode = ExitCode;
	OutResult.ElapsedSeconds = FPlatformTime::Seconds() - StartTime;

	if (!bLaunched)
	{
		return Fail(RunError.IsEmpty() ? FString(TEXT("The converter process could not be run.")) : RunError);
	}
	if (bTimedOut)
	{
		return Fail(FString::Printf(TEXT("Converter timed out after %d seconds."), Options.TimeoutSeconds));
	}
	if (ExitCode != 0)
	{
		FString Detail = StdErr;
		if (Detail.IsEmpty())
		{
			Detail = StdOut;
		}
		Detail.TrimStartAndEndInline();
		if (Detail.Len() > 1200)
		{
			Detail = Detail.Left(1200) + TEXT("...");
		}
		return Fail(FString::Printf(TEXT("Converter exited with code %d.%s%s"),
			ExitCode,
			Detail.IsEmpty() ? TEXT("") : TEXT(" Output: "),
			*Detail));
	}
	if (!IFileManager::Get().FileExists(*JsonFile))
	{
		return Fail(FString::Printf(TEXT("Converter reported success but produced no layout json at '%s'."), *JsonFile));
	}

	OutResult.JsonPath = JsonFile;
	OutResult.bSuccess = true;
	UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG converter: wrote '%s' in %.2fs."), *JsonFile, OutResult.ElapsedSeconds);
	return true;
}
