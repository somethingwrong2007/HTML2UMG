// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "Editor/Html2UMGBlueprintTypes.h"
#include "Editor/Html2UMGConverter.h"
#include "Editor/Html2UMGOptions.h"
#include "Templates/Function.h"

#include "Html2UMGBlueprintLibrary.generated.h"

/**
 * Blueprint / Python entry points for HTML -> UMG.
 *
 * All of these are synchronous and must be called on the game thread (they create and
 * save UObjects). `ImportFromHtml` additionally runs the Node converter in-process, so
 * it can block for a few seconds on a cold run - prefer the panel for interactive use.
 */
UCLASS()
class HTML2UMG_API UHtml2UMGBlueprintLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/**
	 * design.html -> layout json (Node converter) -> Widget Blueprint.
	 * @param HtmlPath Absolute path to the source html.
	 * @param Options  Import options; null = plugin defaults.
	 */
	UFUNCTION(BlueprintCallable, Category = "Html2UMG", meta = (DisplayName = "Import From HTML"))
	static FH2UImportResultBP ImportFromHtml(const FString& HtmlPath, UHtml2UMGImportOptions* Options);

	/**
	 * layout json -> Widget Blueprint (skips the converter).
	 */
	UFUNCTION(BlueprintCallable, Category = "Html2UMG", meta = (DisplayName = "Import From JSON"))
	static FH2UImportResultBP ImportFromJson(const FString& JsonPath, UHtml2UMGImportOptions* Options);

	/**
	 * Runs the Node converter only.
	 * @param OutJsonPath Receives the written json path on success.
	 * @param Viewport    Layout viewport, e.g. (1920, 1080).
	 */
	UFUNCTION(BlueprintCallable, Category = "Html2UMG", meta = (DisplayName = "Convert HTML To JSON"))
	static bool ConvertHtmlToJson(const FString& HtmlPath, FString& OutJsonPath, FVector2D Viewport);

	/**
	 * Renders a widget blueprint offscreen to a png for fidelity comparison.
	 * @param OutPng Absolute png path; empty = <ProjectSaved>/Html2UMG/Fidelity/<name>.png.
	 */
	UFUNCTION(BlueprintCallable, Category = "Html2UMG", meta = (DisplayName = "Render Widget To PNG"))
	static bool RenderWidgetToPng(const FString& BlueprintPath, int32 Width, int32 Height, FString& OutPng);

	/** Creates an options object pre-filled with the plugin defaults. */
	UFUNCTION(BlueprintCallable, Category = "Html2UMG", meta = (DisplayName = "Make Import Options"))
	static UHtml2UMGImportOptions* MakeImportOptions();

	/** Absolute path of <ProjectSaved>/Html2UMG, the converter's working directory. */
	UFUNCTION(BlueprintPure, Category = "Html2UMG", meta = (DisplayName = "Get Work Directory"))
	static FString GetWorkDirectory();

	/** True when a usable node.exe was found (does not check the converter script). */
	UFUNCTION(BlueprintPure, Category = "Html2UMG", meta = (DisplayName = "Is Converter Available"))
	static bool IsConverterAvailable();

	/** Node executable that would be used, or empty. */
	UFUNCTION(BlueprintPure, Category = "Html2UMG", meta = (DisplayName = "Find Node Executable"))
	static FString FindNodeExecutable();

	/** Absolute path of Resources/Converter/cli/convert.js. */
	UFUNCTION(BlueprintPure, Category = "Html2UMG", meta = (DisplayName = "Get Converter Script"))
	static FString GetConverterScriptPath();

	// ---------------------------------------------------------------------
	// C++-only core used by the Slate panel and the commandlet. Keeps the
	// severity-tagged FH2UImportResult instead of the flattened BP struct.
	// ---------------------------------------------------------------------

	/**
	 * layout json -> Widget Blueprint. Game thread only.
	 * @param Sink Optional progress sink, called synchronously on the calling (game) thread.
	 */
	static FH2UImportResult ImportLayoutFileCore(
		const FString& JsonPath,
		const FH2UImportOptions& Options,
		TFunction<void(const FH2UMessage&)> Sink = TFunction<void(const FH2UMessage&)>());

	/** design.html -> layout json through the node CLI. Blocking; safe off the game thread. */
	static bool ConvertHtmlFileCore(const FH2UConvertOptions& ConvertOptions, FH2UConvertResult& OutResult);
};
