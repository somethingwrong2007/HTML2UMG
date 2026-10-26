// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Editor/Html2UMGBlueprintLibrary.h"

#include "Editor/Html2UMGFidelity.h"
#include "HAL/FileManager.h"
#include "Html2UMGLog.h"
#include "Importer/Html2UMGImporter.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"

#define LOCTEXT_NAMESPACE "Html2UMGBlueprintLibrary"

namespace
{
	const TCHAR* GameThreadOnlyMessage = TEXT("Html2UMG can only import or render on the game thread.");

	UHtml2UMGImportOptions* MakeDefaultOptions()
	{
		return NewObject<UHtml2UMGImportOptions>(GetTransientPackage());
	}

	FString ToAbsoluteFile(const FString& InPath)
	{
		FString Path = InPath;
		Path.TrimStartAndEndInline();
		Path.TrimQuotesInline();
		if (Path.IsEmpty())
		{
			return FString();
		}
		return FPaths::ConvertRelativePathToFull(Path);
	}

	void AppendConvertFailure(FH2UImportResult& InOutResult, const FH2UConvertResult& ConvertResult)
	{
		if (!ConvertResult.Error.IsEmpty())
		{
			InOutResult.Error(ConvertResult.Error);
		}
		if (!ConvertResult.StdErr.IsEmpty())
		{
			TArray<FString> Lines;
			ConvertResult.StdErr.ParseIntoArrayLines(Lines, /*bCullEmpty=*/ true);
			for (const FString& Line : Lines)
			{
				InOutResult.Error(Line);
			}
		}
		if (!ConvertResult.StdOut.IsEmpty())
		{
			TArray<FString> Lines;
			ConvertResult.StdOut.ParseIntoArrayLines(Lines, /*bCullEmpty=*/ true);
			for (const FString& Line : Lines)
			{
				InOutResult.Info(Line);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// FH2UImportResultBP
// ---------------------------------------------------------------------------

void FH2UImportResultBP::FromResult(const FH2UImportResult& InResult)
{
	bSuccess = InResult.bSuccess;
	WidgetsCreated = InResult.WidgetsCreated;
	WidgetsReused = InResult.WidgetsReused;
	PropertiesSet = InResult.PropertiesSet;
	BlueprintPath = InResult.BlueprintPath;

	Messages.Reset(InResult.Messages.Num());
	for (const FH2UMessage& Message : InResult.Messages)
	{
		const FString Severity = Message.Severity.IsEmpty() ? FString(TEXT("info")) : Message.Severity;
		Messages.Add(FString::Printf(TEXT("[%s] %s"), *Severity, *Message.Text));
	}
}

FH2UImportResultBP FH2UImportResultBP::MakeFromResult(const FH2UImportResult& InResult)
{
	FH2UImportResultBP Result;
	Result.FromResult(InResult);
	return Result;
}

void FH2UImportResultBP::SetError(const FString& InMessage)
{
	bSuccess = false;
	Messages.Add(FString::Printf(TEXT("[error] %s"), *InMessage));
}

FString FH2UImportResultBP::ToText() const
{
	FString Text = FString::Printf(TEXT("%s (%d created, %d reused, %d properties)%s%s\n"),
		bSuccess ? TEXT("SUCCESS") : TEXT("FAILED"),
		WidgetsCreated,
		WidgetsReused,
		PropertiesSet,
		BlueprintPath.IsEmpty() ? TEXT("") : TEXT(" -> "),
		*BlueprintPath);

	for (const FString& Message : Messages)
	{
		Text += Message;
		Text += TEXT("\n");
	}
	return Text;
}

// ---------------------------------------------------------------------------
// Core (C++ only)
// ---------------------------------------------------------------------------

bool UHtml2UMGBlueprintLibrary::ConvertHtmlFileCore(const FH2UConvertOptions& ConvertOptions, FH2UConvertResult& OutResult)
{
	return FHtml2UMGConverter::ConvertHtmlToLayout(ConvertOptions, OutResult);
}

FH2UImportResult UHtml2UMGBlueprintLibrary::ImportLayoutFileCore(
	const FString& JsonPath,
	const FH2UImportOptions& Options,
	TFunction<void(const FH2UMessage&)> Sink)
{
	FH2UImportResult Result;

	if (!IsInGameThread())
	{
		Result.Error(GameThreadOnlyMessage);
		return Result;
	}

	const FString AbsoluteJson = ToAbsoluteFile(JsonPath);
	if (AbsoluteJson.IsEmpty())
	{
		Result.Error(TEXT("No layout json path was given."));
		return Result;
	}
	if (!IFileManager::Get().FileExists(*AbsoluteJson))
	{
		Result.Error(FString::Printf(TEXT("Layout json not found: %s"), *AbsoluteJson));
		return Result;
	}

	// The importer calls the sink synchronously; always install a valid callable so an
	// implementation that does not null-check cannot crash on a default TFunction.
	TFunction<void(const FH2UMessage&)> EffectiveSink;
	if (Sink)
	{
		EffectiveSink = MoveTemp(Sink);
	}
	else
	{
		EffectiveSink = [](const FH2UMessage&) {};
	}

	FHtml2UMGImporter::SetMessageSink(MoveTemp(EffectiveSink));
	FHtml2UMGImporter::ImportLayoutFile(AbsoluteJson, Options, Result);
	FHtml2UMGImporter::SetMessageSink([](const FH2UMessage&) {});

	if (!Result.bSuccess && Result.ErrorCount() == 0)
	{
		Result.Error(TEXT("The importer reported failure without a message."));
	}
	return Result;
}

// ---------------------------------------------------------------------------
// Blueprint / Python surface
// ---------------------------------------------------------------------------

UHtml2UMGImportOptions* UHtml2UMGBlueprintLibrary::MakeImportOptions()
{
	return MakeDefaultOptions();
}

FString UHtml2UMGBlueprintLibrary::GetWorkDirectory()
{
	return FHtml2UMGConverter::GetWorkDirectory();
}

bool UHtml2UMGBlueprintLibrary::IsConverterAvailable()
{
	FString Error;
	const FString NodeExe = FHtml2UMGConverter::FindNodeExecutable(Error);
	const FString Script = FHtml2UMGConverter::FindConverterScript();
	return !NodeExe.IsEmpty() && !Script.IsEmpty() && IFileManager::Get().FileExists(*Script);
}

FString UHtml2UMGBlueprintLibrary::FindNodeExecutable()
{
	FString Error;
	const FString NodeExe = FHtml2UMGConverter::FindNodeExecutable(Error);
	if (NodeExe.IsEmpty() && !Error.IsEmpty())
	{
		UE_LOG(LogHtml2UMG, Warning, TEXT("%s"), *Error);
	}
	return NodeExe;
}

FString UHtml2UMGBlueprintLibrary::GetConverterScriptPath()
{
	return FHtml2UMGConverter::FindConverterScript();
}

FH2UImportResultBP UHtml2UMGBlueprintLibrary::ImportFromHtml(const FString& HtmlPath, UHtml2UMGImportOptions* Options)
{
	FH2UImportResult Result;

	if (!IsInGameThread())
	{
		Result.Error(GameThreadOnlyMessage);
		return FH2UImportResultBP::MakeFromResult(Result);
	}

	const FString AbsoluteHtml = ToAbsoluteFile(HtmlPath);
	if (AbsoluteHtml.IsEmpty())
	{
		Result.Error(TEXT("ImportFromHtml: no html path was given."));
		return FH2UImportResultBP::MakeFromResult(Result);
	}
	if (!IFileManager::Get().FileExists(*AbsoluteHtml))
	{
		Result.Error(FString::Printf(TEXT("ImportFromHtml: html file not found: %s"), *AbsoluteHtml));
		return FH2UImportResultBP::MakeFromResult(Result);
	}

	UHtml2UMGImportOptions* EffectiveOptions = Options != nullptr ? Options : MakeDefaultOptions();

	FH2UConvertOptions ConvertOptions;
	ConvertOptions.HtmlFile = AbsoluteHtml;
	ConvertOptions.Viewport = EffectiveOptions->GetViewportSize();

	FH2UConvertResult ConvertResult;
	if (!ConvertHtmlFileCore(ConvertOptions, ConvertResult))
	{
		AppendConvertFailure(Result, ConvertResult);
		return FH2UImportResultBP::MakeFromResult(Result);
	}

	Result.Info(FString::Printf(TEXT("Converted '%s' to '%s' in %.2fs."), *AbsoluteHtml, *ConvertResult.JsonPath, ConvertResult.ElapsedSeconds));

	FH2UImportResult ImportResult = ImportLayoutFileCore(ConvertResult.JsonPath, EffectiveOptions->ToImportOptions());
	// Keep the conversion note at the front of the message list.
	ImportResult.Messages.Insert(FH2UMessage(TEXT("info"), FString::Printf(TEXT("layout json: %s"), *ConvertResult.JsonPath)), 0);
	return FH2UImportResultBP::MakeFromResult(ImportResult);
}

FH2UImportResultBP UHtml2UMGBlueprintLibrary::ImportFromJson(const FString& JsonPath, UHtml2UMGImportOptions* Options)
{
	if (!IsInGameThread())
	{
		FH2UImportResult ThreadResult;
		ThreadResult.Error(GameThreadOnlyMessage);
		return FH2UImportResultBP::MakeFromResult(ThreadResult);
	}

	UHtml2UMGImportOptions* EffectiveOptions = Options != nullptr ? Options : MakeDefaultOptions();
	return FH2UImportResultBP::MakeFromResult(ImportLayoutFileCore(JsonPath, EffectiveOptions->ToImportOptions()));
}

bool UHtml2UMGBlueprintLibrary::ConvertHtmlToJson(const FString& HtmlPath, FString& OutJsonPath, FVector2D Viewport)
{
	OutJsonPath.Reset();

	FH2UConvertOptions ConvertOptions;
	ConvertOptions.HtmlFile = ToAbsoluteFile(HtmlPath);
	ConvertOptions.Viewport = FVector2D(
		Viewport.X > 0.0 ? Viewport.X : 1920.0,
		Viewport.Y > 0.0 ? Viewport.Y : 1080.0);

	if (ConvertOptions.HtmlFile.IsEmpty())
	{
		UE_LOG(LogHtml2UMG, Error, TEXT("ConvertHtmlToJson: no html path was given."));
		return false;
	}

	FH2UConvertResult ConvertResult;
	const bool bSuccess = ConvertHtmlFileCore(ConvertOptions, ConvertResult);
	if (bSuccess)
	{
		OutJsonPath = ConvertResult.JsonPath;
	}
	else if (!ConvertResult.Error.IsEmpty())
	{
		UE_LOG(LogHtml2UMG, Error, TEXT("ConvertHtmlToJson: %s"), *ConvertResult.Error);
	}
	return bSuccess;
}

bool UHtml2UMGBlueprintLibrary::RenderWidgetToPng(const FString& BlueprintPath, int32 Width, int32 Height, FString& OutPng)
{
	if (!IsInGameThread())
	{
		UE_LOG(LogHtml2UMG, Error, TEXT("RenderWidgetToPng: %s"), GameThreadOnlyMessage);
		return false;
	}

	const FVector2D Size(
		Width > 0 ? static_cast<double>(Width) : 1920.0,
		Height > 0 ? static_cast<double>(Height) : 1080.0);

	FString Error;
	const bool bHasExplicitPath = !OutPng.IsEmpty();

	if (bHasExplicitPath)
	{
		if (!FHtml2UMGFidelity::RenderWidgetToFile(BlueprintPath, Size, OutPng, Error))
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("RenderWidgetToPng: %s"), *Error);
			return false;
		}
		return true;
	}

	FString RenderedFile;
	if (!FHtml2UMGFidelity::RenderWidgetToFolder(BlueprintPath, Size, FString(), RenderedFile, Error))
	{
		UE_LOG(LogHtml2UMG, Error, TEXT("RenderWidgetToPng: %s"), *Error);
		return false;
	}
	OutPng = RenderedFile;
	return true;
}

#undef LOCTEXT_NAMESPACE
