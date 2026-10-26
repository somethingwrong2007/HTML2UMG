// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Editor/Html2UMGCommandlet.h"

#include "DynamicRHI.h"
#include "Editor/Html2UMGBlueprintLibrary.h"
#include "Editor/Html2UMGConverter.h"
#include "Editor/Html2UMGFidelity.h"
#include "Editor/Html2UMGOptions.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "Html2UMGLog.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/App.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "RHIGlobals.h"
#include "Rendering/SlateRenderer.h"
#include "UObject/Package.h"

namespace
{
	FString YesNo(bool bValue)
	{
		return bValue ? TEXT("yes") : TEXT("no");
	}

	FString Trimmed(FString Value)
	{
		Value.TrimStartAndEndInline();
		Value.TrimQuotesInline();
		return Value;
	}

	/** One line per message, severity first, so CI logs stay greppable. */
	FString FormatMessages(const TArray<FH2UMessage>& Messages)
	{
		FString Text;
		for (const FH2UMessage& Message : Messages)
		{
			Text += FString::Printf(TEXT("  [%s] %s\n"),
				Message.Severity.IsEmpty() ? TEXT("info") : *Message.Severity,
				*Message.Text);
		}
		return Text;
	}

	/** The importer is still a stub early in the project; say so instead of looking broken. */
	bool LooksLikeStub(const FH2UImportResult& Result)
	{
		for (const FH2UMessage& Message : Result.Messages)
		{
			if (Message.Text.Contains(TEXT("not implemented"), ESearchCase::IgnoreCase)
				|| Message.Text.Contains(TEXT("not yet"), ESearchCase::IgnoreCase))
			{
				return true;
			}
		}
		return false;
	}

	/** FWidgetRenderer needs both: a Slate application and its initialised renderer. */
	bool HasSlateRenderer()
	{
		return FSlateApplication::IsInitialized() && FSlateApplication::Get().GetRenderer() != nullptr;
	}

	/**
	 * The editor-side one-shot that does import + png in a single transaction.
	 * -ExecCmds separates commands with commas (not semicolons).
	 */
	FString MakeRenderHint(const FString& JsonFile, const FString& BlueprintPath, const FString& OutPng, const FVector2D& Viewport)
	{
		return FString::Printf(
			TEXT("PNG rendering needs the editor (Slate/RHI); a -run= commandlet never initialises the Slate renderer.\n")
			TEXT("  Run instead:\n")
			TEXT("    UnrealEditor-Cmd.exe <project>.uproject -ExecCmds=\"Html2UMG.ImportAndRender \"\"%s\"\" \"\"%s\"\" \"\"%s\"\" %dx%d, QUIT_EDITOR\" -unattended -nosplash -windowed -ResX=64 -ResY=64"),
			*JsonFile,
			*BlueprintPath,
			*OutPng,
			FMath::RoundToInt32(Viewport.X),
			FMath::RoundToInt32(Viewport.Y));
	}

	FString BuildEnvironmentReport()
	{
		FString Report;
		Report += TEXT("-- environment --\n");

		const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("Html2UMG"));
		const FString PluginDir = Plugin.IsValid() ? Plugin->GetBaseDir() : FString(TEXT("<not found>"));
		Report += FString::Printf(TEXT("  project:        %s\n"), *FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()));
		Report += FString::Printf(TEXT("  plugin:         %s\n"), *PluginDir);

		const FString Script = FHtml2UMGConverter::FindConverterScript();
		const bool bScriptExists = !Script.IsEmpty() && IFileManager::Get().FileExists(*Script);
		Report += FString::Printf(TEXT("  converter js:   %s (%s)\n"),
			Script.IsEmpty() ? TEXT("<not found>") : *Script,
			bScriptExists ? TEXT("present") : TEXT("MISSING"));

		FString NodeError;
		const FString NodeExe = FHtml2UMGConverter::FindNodeExecutable(NodeError);
		if (NodeExe.IsEmpty())
		{
			Report += FString::Printf(TEXT("  node:           <not found> (%s)\n"), *NodeError);
		}
		else
		{
			const FString Version = FHtml2UMGConverter::QueryNodeVersion(NodeExe);
			Report += FString::Printf(TEXT("  node:           %s (%s)\n"), *NodeExe, Version.IsEmpty() ? TEXT("unknown version") : *Version);
		}

		Report += FString::Printf(TEXT("  work dir:       %s\n"), *FHtml2UMGConverter::GetWorkDirectory());

		// Capability report: these three lines explain every degradation below.
		const TCHAR* RhiName = GDynamicRHI != nullptr ? GDynamicRHI->GetName() : TEXT("<none>");
		const bool bCanRender = FApp::CanEverRender();
		const bool bSlateApp = FSlateApplication::IsInitialized();
		const bool bSlateRenderer = HasSlateRenderer();

		Report += FString::Printf(TEXT("  rhi:            %s (nullrhi=%s)\n"), RhiName, *YesNo(GUsingNullRHI));
		Report += FString::Printf(TEXT("  renderer:       %s (FApp::CanEverRender)\n"), *YesNo(bCanRender));
		Report += FString::Printf(TEXT("  slate app:      %s\n"), *YesNo(bSlateApp));
		Report += FString::Printf(TEXT("  slate renderer: %s%s\n"),
			*YesNo(bSlateRenderer),
			bSlateRenderer ? TEXT("") : TEXT("  (always no under -run=: font import and png output are unavailable)"));

		if (!bCanRender || !bSlateRenderer)
		{
			Report += TEXT("  capabilities:   layout + textures + reflected properties: yes | fonts: no | png: no\n");
		}
		else
		{
			Report += TEXT("  capabilities:   layout + textures + reflected properties: yes | fonts: yes | png: yes\n");
		}
		return Report;
	}
}

UHtml2UMGCommandlet::UHtml2UMGCommandlet()
{
	IsClient = false;
	IsServer = false;
	IsEditor = true;
	LogToConsole = true;
}

bool UHtml2UMGCommandlet::ParseSizeToken(const FString& Token, FVector2D& OutSize)
{
	FString Left;
	FString Right;
	if (!Trimmed(Token).Split(TEXT("x"), &Left, &Right))
	{
		// Accept an upper-case separator too ("1920X1080").
		if (!Trimmed(Token).Split(TEXT("X"), &Left, &Right))
		{
			return false;
		}
	}

	if (!Left.IsNumeric() || !Right.IsNumeric())
	{
		return false;
	}

	const double Width = FCString::Atod(*Left);
	const double Height = FCString::Atod(*Right);
	if (Width < 64.0 || Height < 64.0 || Width > 8192.0 || Height > 8192.0)
	{
		return false;
	}

	OutSize = FVector2D(Width, Height);
	return true;
}

void UHtml2UMGCommandlet::LogReport(const FString& Report)
{
	TArray<FString> Lines;
	Report.ParseIntoArrayLines(Lines, /*bCullEmpty=*/ false);
	for (const FString& Line : Lines)
	{
		UE_LOG(LogHtml2UMG, Display, TEXT("%s"), *Line);
	}
}

int32 UHtml2UMGCommandlet::Main(const FString& Params)
{
	// ---------------------------------------------------------------- arguments
	FString HtmlArg;
	FString JsonArg;
	FString BlueprintArg;
	FString ParentArg;
	FString AssetsArg;
	FString OutPngArg;
	FString ViewportArg;
	FString ProbeArg;
	FString TimeoutArg;

	FParse::Value(*Params, TEXT("html="), HtmlArg);
	FParse::Value(*Params, TEXT("json="), JsonArg);
	FParse::Value(*Params, TEXT("blueprint="), BlueprintArg);
	FParse::Value(*Params, TEXT("parent="), ParentArg);
	FParse::Value(*Params, TEXT("assets="), AssetsArg);
	FParse::Value(*Params, TEXT("out-png="), OutPngArg);
	FParse::Value(*Params, TEXT("viewport="), ViewportArg);
	FParse::Value(*Params, TEXT("probe="), ProbeArg);
	FParse::Value(*Params, TEXT("timeout="), TimeoutArg);

	const bool bNoCompile = FParse::Param(*Params, TEXT("no-compile"));
	const bool bNoSave = FParse::Param(*Params, TEXT("no-save"));
	const bool bStrict = FParse::Param(*Params, TEXT("strict"));

	HtmlArg = Trimmed(HtmlArg);
	JsonArg = Trimmed(JsonArg);
	BlueprintArg = Trimmed(BlueprintArg);
	ParentArg = Trimmed(ParentArg);
	AssetsArg = Trimmed(AssetsArg);
	OutPngArg = Trimmed(OutPngArg);
	ViewportArg = Trimmed(ViewportArg);
	ProbeArg = Trimmed(ProbeArg);

	/** The one line CI parses; always emitted, always last. */
	auto EmitSummary = [](const TCHAR* Status, const FString& Reason, const FH2UImportResult& Result, const FString& Extra)
	{
		FString Line = FString::Printf(TEXT("[Html2UMG] %s"), Status);
		if (!Reason.IsEmpty())
		{
			Line += FString::Printf(TEXT(" reason=%s"), *Reason);
		}
		Line += FString::Printf(TEXT(" widgets=%d properties=%d warnings=%d errors=%d blueprint=%s"),
			Result.WidgetsCreated,
			Result.PropertiesSet,
			Result.WarningCount(),
			Result.ErrorCount(),
			Result.BlueprintPath.IsEmpty() ? TEXT("<none>") : *Result.BlueprintPath);
		if (!Extra.IsEmpty())
		{
			Line += TEXT(" ") + Extra;
		}
		UE_LOG(LogHtml2UMG, Display, TEXT("%s"), *Line);
	};

	const FH2UImportResult EmptyResult;

	FVector2D Viewport(1920.0, 1080.0);
	if (!ViewportArg.IsEmpty() && !ParseSizeToken(ViewportArg, Viewport))
	{
		UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG: invalid -viewport='%s' (expected WxH, 64..8192)."), *ViewportArg);
		EmitSummary(TEXT("FAILED"), TEXT("bad-viewport"), EmptyResult, FString());
		return Exit_Failed;
	}

	TArray<FVector2D> Probes;
	if (!ProbeArg.IsEmpty())
	{
		TArray<FString> ProbeTokens;
		ProbeArg.ParseIntoArray(ProbeTokens, TEXT(","), /*bCullEmpty=*/ true);
		for (const FString& Token : ProbeTokens)
		{
			FVector2D Probe;
			if (!ParseSizeToken(Token, Probe))
			{
				UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG: invalid -probe token '%s' (expected WxH)."), *Token);
				EmitSummary(TEXT("FAILED"), TEXT("bad-probe"), EmptyResult, FString());
				return Exit_Failed;
			}
			Probes.Add(Probe);
		}
	}

	int32 TimeoutSeconds = 30;
	if (!TimeoutArg.IsEmpty())
	{
		TimeoutSeconds = FMath::Clamp(FCString::Atoi(*TimeoutArg), 1, 600);
	}

	// Capability detection, once: everything below degrades against these.
	const bool bSlateApp = FSlateApplication::IsInitialized();
	const bool bCanRender = bSlateApp && HasSlateRenderer() && FApp::CanEverRender();

	UE_LOG(LogHtml2UMG, Display, TEXT("=== Html2UMG commandlet ==="));
	LogReport(BuildEnvironmentReport());

	// ------------------------------------------------------------------ convert
	FString JsonFile = JsonArg;
	if (!HtmlArg.IsEmpty())
	{
		const FString HtmlFile = FPaths::ConvertRelativePathToFull(HtmlArg);
		if (!IFileManager::Get().FileExists(*HtmlFile))
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG: -html file not found: %s"), *HtmlFile);
			EmitSummary(TEXT("FAILED"), TEXT("html-not-found"), EmptyResult, FString());
			return Exit_Failed;
		}

		FH2UConvertOptions ConvertOptions;
		ConvertOptions.HtmlFile = HtmlFile;
		ConvertOptions.Viewport = Viewport;
		ConvertOptions.Probes = Probes;
		ConvertOptions.TimeoutSeconds = TimeoutSeconds;
		ConvertOptions.BlueprintPath = BlueprintArg;
		ConvertOptions.bStrict = bStrict;
		if (!JsonFile.IsEmpty())
		{
			ConvertOptions.JsonFile = FPaths::ConvertRelativePathToFull(JsonFile);
		}

		FH2UConvertResult ConvertResult;
		const bool bConverted = UHtml2UMGBlueprintLibrary::ConvertHtmlFileCore(ConvertOptions, ConvertResult);

		FString ConvertReport;
		ConvertReport += bConverted ? TEXT("-- convert: OK --\n") : TEXT("-- convert: FAILED --\n");
		ConvertReport += ConvertResult.ToText();
		LogReport(ConvertReport);

		if (!bConverted)
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG: conversion failed, nothing to import."));
			EmitSummary(TEXT("FAILED"), TEXT("convert-failed"), EmptyResult, FString());
			return Exit_Failed;
		}

		JsonFile = ConvertResult.JsonPath;
	}

	// ------------------------------------------------- no input at all: diagnose
	if (JsonFile.IsEmpty())
	{
		LogReport(TEXT("-- no -html= or -json= given: environment diagnostics only --\n"
			"   usage: -run=Html2UMG -html=\"D:/design.html\" [-blueprint=/Game/UI/WBP_Design]\n"
			"          -run=Html2UMG -json=\"D:/design.json\" [-no-compile] [-no-save] [-strict]\n"
			"   note:  -out-png cannot work under -run=; use Html2UMG.ImportAndRender from the editor."));
		UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG: nothing to do (no -html / -json)."));
		EmitSummary(TEXT("SUCCESS"), TEXT("diagnostics-only"), EmptyResult, FString());
		return Exit_Success;
	}

	// ------------------------------------------------------------------- import
	JsonFile = FPaths::ConvertRelativePathToFull(JsonFile);
	if (!IFileManager::Get().FileExists(*JsonFile))
	{
		UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG: layout json not found: %s"), *JsonFile);
		EmitSummary(TEXT("FAILED"), TEXT("json-not-found"), EmptyResult, FString());
		return Exit_Failed;
	}

	UHtml2UMGImportOptions* Options = NewObject<UHtml2UMGImportOptions>(GetTransientPackage());
	Options->BlueprintPath = BlueprintArg;
	Options->ParentClassPath = ParentArg;
	if (!AssetsArg.IsEmpty())
	{
		Options->AssetOutputRoot = AssetsArg;
	}
	Options->bCompile = !bNoCompile;
	Options->bSave = !bNoSave;
	Options->ViewportWidth = FMath::RoundToInt32(Viewport.X);
	Options->ViewportHeight = FMath::RoundToInt32(Viewport.Y);

	// Importing a font face builds a Slate font atlas, which needs a live FSlateApplication.
	// A -run= commandlet has none, so degrade with a warning instead of asserting in UMG.
	if (!bSlateApp && Options->bImportFonts)
	{
		Options->bImportFonts = false;
		UE_LOG(LogHtml2UMG, Warning,
			TEXT("Html2UMG: font import requires the editor's Slate application; run from the Tools > HTML to UMG panel ")
			TEXT("to import real typefaces. Layout, textures, sizes and colours are unaffected."));
	}

	UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG: importing '%s' (compile=%s save=%s fonts=%s blueprint='%s')"),
		*JsonFile,
		*YesNo(Options->bCompile),
		*YesNo(Options->bSave),
		*YesNo(Options->bImportFonts),
		BlueprintArg.IsEmpty() ? TEXT("<from json>") : *BlueprintArg);

	const FH2UImportResult ImportResult = UHtml2UMGBlueprintLibrary::ImportLayoutFileCore(
		JsonFile,
		Options->ToImportOptions(),
		[](const FH2UMessage& Message)
		{
			UE_LOG(LogHtml2UMG, Display, TEXT("  [%s] %s"),
				Message.Severity.IsEmpty() ? TEXT("info") : *Message.Severity,
				*Message.Text);
		});

	if (!ImportResult.bSuccess)
	{
		FString FailureReport = TEXT("-- import: FAILED --\n");
		FailureReport += FormatMessages(ImportResult.Messages);
		if (LooksLikeStub(ImportResult))
		{
			FailureReport += TEXT("  hint: the widget importer is still a stub (owned by the importer workstream); ")
				TEXT("the editor surface itself ran correctly.\n");
		}
		LogReport(FailureReport);
		EmitSummary(TEXT("FAILED"), TEXT("import-failed"), ImportResult, FString());
		return Exit_Failed;
	}

	// ------------------------------------------------------------------- render
	if (!OutPngArg.IsEmpty())
	{
		const FString RenderBlueprint = BlueprintArg.IsEmpty() ? ImportResult.BlueprintPath : BlueprintArg;

		if (!bCanRender)
		{
			// Not a failure: the import worked, the pixels just cannot be drawn in this process.
			UE_LOG(LogHtml2UMG, Warning,
				TEXT("Html2UMG: PNG rendering needs the editor (Slate/RHI); it is unavailable under -run=. Skipping -out-png='%s'."),
				*OutPngArg);
			LogReport(MakeRenderHint(JsonFile, RenderBlueprint, OutPngArg, Viewport));
		}
		else
		{
			if (RenderBlueprint.IsEmpty())
			{
				UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG: -out-png was given but no blueprint path is known. Pass -blueprint=."));
				EmitSummary(TEXT("FAILED"), TEXT("render-no-blueprint"), ImportResult, FString());
				return Exit_Failed;
			}

			FString RenderError;
			if (!FHtml2UMGFidelity::RenderWidgetToFile(RenderBlueprint, Viewport, OutPngArg, RenderError))
			{
				UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG: render to png failed: %s"), *RenderError);
				LogReport(MakeRenderHint(JsonFile, RenderBlueprint, OutPngArg, Viewport));
				EmitSummary(TEXT("FAILED"), TEXT("render-failed"), ImportResult, FString());
				return Exit_Failed;
			}
			UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG: wrote fidelity png '%s'."), *OutPngArg);
		}
	}

	// ------------------------------------------------------------------ summary
	const int32 ErrorCount = ImportResult.ErrorCount();
	const int32 WarningCount = ImportResult.WarningCount();

	FString Summary;
	Summary += TEXT("-- summary --\n");
	Summary += FString::Printf(TEXT("  json:       %s\n"), *JsonFile);
	Summary += FString::Printf(TEXT("  blueprint:  %s\n"), ImportResult.BlueprintPath.IsEmpty() ? TEXT("<none>") : *ImportResult.BlueprintPath);
	Summary += FString::Printf(TEXT("  widgets:    %d created, %d reused, %d properties set\n"),
		ImportResult.WidgetsCreated, ImportResult.WidgetsReused, ImportResult.PropertiesSet);
	Summary += FString::Printf(TEXT("  messages:   %d error(s), %d warning(s)\n"), ErrorCount, WarningCount);
	Summary += FString::Printf(TEXT("  fonts:      %s\n"), *YesNo(Options->bImportFonts));
	Summary += FString::Printf(TEXT("  out-png:    %s\n"),
		OutPngArg.IsEmpty() ? TEXT("<not requested>") : (bCanRender ? *OutPngArg : TEXT("<skipped: no Slate/RHI>")));
	if (!ImportResult.Messages.IsEmpty())
	{
		Summary += FormatMessages(ImportResult.Messages);
	}

	if (bStrict && WarningCount > 0)
	{
		Summary += TEXT("  result:     FAILED (strict mode: warnings are errors)\n");
		LogReport(Summary);
		EmitSummary(TEXT("FAILED"), TEXT("strict-warnings"), ImportResult, FString());
		return Exit_StrictWarnings;
	}

	Summary += TEXT("  result:     SUCCESS\n");
	LogReport(Summary);
	EmitSummary(TEXT("SUCCESS"), FString(), ImportResult, FString());
	return Exit_Success;
}
