// Copyright (c) 2026 FPVSkyline. MIT License.
//
// Console commands that make the whole pipeline runnable from -ExecCmds, i.e. from a
// script, without a human in the editor:
//
//   UnrealEditor.exe <uproject> -ExecCmds="Html2UMG.ImportAndRender C:/w/layout.json /Game/UI/WBP_X C:/w/umg.png 1920x1080, QUIT_EDITOR"
//
// NOTE: Unreal splits -ExecCmds on COMMAS, not semicolons. A ';' ends up inside the
// last argument, which is how a blueprint path silently gains a trailing ';'.
//
// These live in their own file so they do not collide with the interactive surface in
// Html2UMGEditor.cpp.

#include "CoreMinimal.h"
#include "HAL/IConsoleManager.h"
#include "Misc/CString.h"
#include "Misc/Paths.h"
#include "Html2UMGLog.h"
#include "Editor/Html2UMGFidelity.h"
#include "Importer/Html2UMGImporter.h"

namespace
{
	/** "1920x1080" / "1920X1080" / "1920*1080" -> FVector2D. Falls back to 1920x1080. */
	FVector2D ParseSize(const FString& InText, const FVector2D& Fallback = FVector2D(1920.0, 1080.0))
	{
		FString Left;
		FString Right;
		if (!InText.Split(TEXT("x"), &Left, &Right))
		{
			if (!InText.Split(TEXT("X"), &Left, &Right))
			{
				if (!InText.Split(TEXT("*"), &Left, &Right))
				{
					return Fallback;
				}
			}
		}

		const double Width = FCString::Atod(*Left);
		const double Height = FCString::Atod(*Right);
		if (Width <= 0.0 || Height <= 0.0)
		{
			return Fallback;
		}
		return FVector2D(Width, Height);
	}

	/** Absolute path, tolerating a leading/trailing quote that survived cmd.exe quoting. */
	FString CleanPath(FString InPath)
	{
		InPath.TrimStartAndEndInline();
		InPath.ReplaceInline(TEXT("\""), TEXT(""));
		FPaths::NormalizeFilename(InPath);
		if (FPaths::IsRelative(InPath))
		{
			InPath = FPaths::ConvertRelativePathToFull(FPaths::Combine(FPaths::ProjectDir(), InPath));
		}
		return InPath;
	}

	void LogUsage()
	{
		UE_LOG(LogHtml2UMG, Warning, TEXT("Usage: Html2UMG.RenderPng <blueprintPath> <out.png> <W>x<H>"));
	}

	void RenderPngCommand(const TArray<FString>& Args)
	{
		if (Args.Num() < 3)
		{
			LogUsage();
			return;
		}

		const FString BlueprintPath = Args[0];
		const FString OutPng = CleanPath(Args[1]);
		const FVector2D Size = ParseSize(Args[2]);

		FString Error;
		UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.RenderPng: rendering '%s' at %.0fx%.0f -> '%s'"),
			*BlueprintPath, Size.X, Size.Y, *OutPng);

		if (FHtml2UMGFidelity::RenderWidgetToFile(BlueprintPath, Size, OutPng, Error))
		{
			UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.RenderPng: SUCCESS -> %s"), *OutPng);
		}
		else
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.RenderPng: FAILED - %s"), *Error);
		}
	}

	/**
	 * Import a layout and render it in one game-thread transaction, so a script never has to
	 * reason about whether the asset finished saving before the render starts.
	 */
	void ImportAndRenderCommand(const TArray<FString>& Args)
	{
		if (Args.Num() < 3)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Usage: Html2UMG.ImportAndRender <layout.json> <blueprintPath> <out.png> [WxH]"));
			return;
		}

		const FString JsonFile = CleanPath(Args[0]);
		const FString BlueprintPath = Args[1];
		const FString OutPng = CleanPath(Args[2]);
		const FVector2D Size = Args.Num() >= 4 ? ParseSize(Args[3]) : FVector2D(1920.0, 1080.0);

		FH2UImportOptions Options;
		Options.BlueprintPath = BlueprintPath;
		Options.bCompile = true;
		Options.bSave = true;

		FH2UImportResult Result;
		UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.ImportAndRender: importing '%s' -> '%s'"), *JsonFile, *BlueprintPath);

		const bool bImported = FHtml2UMGImporter::ImportLayoutFile(JsonFile, Options, Result);
		UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.ImportAndRender: import %s (%d created, %d reused, %d properties, %d error(s), %d warning(s))"),
			bImported ? TEXT("SUCCESS") : TEXT("FAILED"),
			Result.WidgetsCreated, Result.WidgetsReused, Result.PropertiesSet,
			Result.ErrorCount(), Result.WarningCount());

		if (!bImported)
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.ImportAndRender: aborting render because the import failed."));
			return;
		}

		FString Error;
		const FString RenderTarget = Result.BlueprintPath.IsEmpty() ? BlueprintPath : Result.BlueprintPath;
		if (FHtml2UMGFidelity::RenderWidgetToFile(RenderTarget, Size, OutPng, Error))
		{
			UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.ImportAndRender: SUCCESS -> %s"), *OutPng);
		}
		else
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.ImportAndRender: import ok but render FAILED - %s"), *Error);
		}
	}

	void ConvertAndImportCommand(const TArray<FString>& Args)
	{
		if (Args.Num() < 3)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Usage: Html2UMG.ConvertImportRender <design.html> <blueprintPath> <out.png> [WxH]"));
			return;
		}
		UE_LOG(LogHtml2UMG, Warning,
			TEXT("Html2UMG.ConvertImportRender: run the Node converter first (node cli/convert.js ...), "
			     "then use Html2UMG.ImportAndRender. Converters are not spawned from the command line path on purpose."));
	}
}

static FAutoConsoleCommand GRenderPngCommand(
	TEXT("Html2UMG.RenderPng"),
	TEXT("Renders a Widget Blueprint to a PNG for fidelity comparison. Usage: Html2UMG.RenderPng <blueprintPath> <out.png> <W>x<H>"),
	FConsoleCommandWithArgsDelegate::CreateStatic(&RenderPngCommand));

static FAutoConsoleCommand GImportAndRenderCommand(
	TEXT("Html2UMG.ImportAndRender"),
	TEXT("Imports a layout json and renders the resulting widget in one step. Usage: Html2UMG.ImportAndRender <layout.json> <blueprintPath> <out.png> [WxH]"),
	FConsoleCommandWithArgsDelegate::CreateStatic(&ImportAndRenderCommand));
