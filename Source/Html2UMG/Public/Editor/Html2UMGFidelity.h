// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"

class SWidget;

/**
 * Fidelity ("对拍") helper: renders a Widget Blueprint offscreen so the imported UMG
 * tree can be compared against the HTML the design came from.
 *
 * Game thread only - it touches UObjects, the editor world and the renderer.
 */
class HTML2UMG_API FHtml2UMGFidelity
{
public:
	/**
	 * Renders BlueprintPath at Size and saves it as a PNG to OutPng.
	 *
	 * Loads the UWidgetBlueprint, compiles it when it has no GeneratedClass, creates
	 * the user widget in the editor world and draws it with FWidgetRenderer.
	 *
	 * @param BlueprintPath Object path, e.g. /Game/UI/WBP_Design.
	 * @param Size          Render target size in pixels.
	 * @param OutPng        Destination png file (absolute, or relative to the project dir).
	 * @param OutError      Human readable failure reason.
	 * @return true when the png was written.
	 */
	static bool RenderWidgetToFile(const FString& BlueprintPath, FVector2D Size, const FString& OutPng, FString& OutError,
		const FString& OutGeometryJson = FString());

	/** Same as above but writes the png next to the blueprint's saved folder with a generated name. */
	static bool RenderWidgetToFolder(const FString& BlueprintPath, FVector2D Size, const FString& OutDirectory, FString& OutPngFile, FString& OutError);

	/**
	 * Renders an arbitrary Slate tree at Size and saves it as a PNG to OutPng.
	 *
	 * This is what makes the Slate output verifiable: a generated SCompoundWidget is drawn through the
	 * same FWidgetRenderer path as a UMG widget, so the png can be diffed against the browser reference
	 * with the same tool. Nothing in it is UMG-specific.
	 *
	 * @param SlateWidget Root of the tree to draw.
	 * @param Size        Render target size in pixels.
	 * @param OutPng      Destination png file (absolute, or relative to the project dir).
	 * @param OutError    Human readable failure reason.
	 * @return true when the png was written.
	 */
	static bool RenderSlateTreeToFile(const TSharedRef<SWidget>& SlateWidget, FVector2D Size, const FString& OutPng, FString& OutError);
};
