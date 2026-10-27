// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Components/PanelWidget.h"
#include "H2URelativeBox.generated.h"

class SH2URelativeBox;

/**
 * A single-child box whose content size is a PERCENTAGE of the space it was given, optionally
 * clamped by pixel limits - the one thing UMG cannot express with Box/SizeBox/Canvas alone:
 *
 *   width  = WidthPercent  > 0 ? allottedWidth  * WidthPercent  : child's desired width
 *   width  = clamp(width, MinWidth, MaxWidth)          (same rule on the height axis)
 *
 * Why this exists: a CSS `width: 92%; max-width: 1240px` (and min(px, vw) style combinations)
 * has no UMG equivalent. USizeBox clamps the DESIRED size only (Slate SBox arranges to the
 * allotted geometry), so in a Fill slot a max-width does nothing; a CanvasPanel anchor gives a
 * percentage of the viewport but cannot be clamped in px. Arranging by percentage on every layout
 * pass fixes both at once and stays continuous while the viewport resizes.
 *
 * dpi/scale: percentages are of the space the parent allotted, so the widget needs no knowledge of
 * the viewport. ContentHAlign/ContentVAlign place the resolved size inside the allotted box
 * (Fill behaves like Left/Top: the resolved size wins, only the offset is affected).
 *
 * Edge cases spelled out:
 *  - No rule on an axis (percent <= 0, min <= 0, max <= 0) => plain panel behaviour: the child is
 *    allotted the whole space. A box that was never configured therefore cannot shrink its content.
 *  - Allotted space smaller than MinWidth/MinHeight => the child is laid out at the MINIMUM and is
 *    allowed to overflow. The box does not clip (Slate clips at the widget that asked for clipping),
 *    so put a Clipping/ScrollBox parent around it when overflow must be hidden.
 *  - WidthPercent/MaxWidth of 0 mean "unset", not "zero pixels"; a percentage of exactly 0 cannot be
 *    expressed (use a spacer or a SizeBox with WidthOverride 0 for that).
 */
UCLASS(BlueprintType, Blueprintable, meta = (DisplayName = "Relative Box"))
class HTML2UMGRUNTIME_API UH2URelativeBox : public UPanelWidget
{
	GENERATED_BODY()

public:
	UH2URelativeBox(const FObjectInitializer& ObjectInitializer);

	/** 0 = ignore (use the child's desired width). 0.92 = 92% of the allotted width. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Relative Box", meta = (ClampMin = "0.0", ClampMax = "1.0"))
	float WidthPercent = 0.0f;

	/** Pixel clamps applied after the percentage. 0 = no limit. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Relative Box")
	float MinWidth = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Relative Box")
	float MaxWidth = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Relative Box", meta = (ClampMin = "0.0", ClampMax = "1.0"))
	float HeightPercent = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Relative Box")
	float MinHeight = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Relative Box")
	float MaxHeight = 0.0f;

	/**
	 * Where the resolved content box sits inside the space this widget was given, as a FRACTION:
	 * 0 = left/top, 0.5 = centre, 1 = right/bottom.
	 *
	 * Deliberately a float and not a TEnumAsByte: the layout contract carries
	 * "ContentHAlign": 0.5, and a byte enum swallows that (0.5 truncates to HAlign_Left), which is
	 * exactly why the first version laid the content out flush left instead of centred.
	 */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Relative Box", meta = (ClampMin = "0.0", ClampMax = "1.0"))
	float ContentHAlign = 0.5f;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Relative Box", meta = (ClampMin = "0.0", ClampMax = "1.0"))
	float ContentVAlign = 0.5f;

	/** Space kept free around the resolved content box (CSS padding on the box itself). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Relative Box")
	FMargin ContentPadding;

	//~ Begin UWidget interface
	virtual TSharedRef<SWidget> RebuildWidget() override;
	virtual void SynchronizeProperties() override;
	virtual void ReleaseSlateResources(bool bReleaseChildren) override;
#if WITH_EDITOR
	virtual const FText GetPaletteCategory() override;
#endif
	//~ End UWidget interface

	//~ Begin UPanelWidget interface
	virtual void OnSlotAdded(UPanelSlot* InSlot) override;
	virtual void OnSlotRemoved(UPanelSlot* InSlot) override;
	//~ End UPanelWidget interface

protected:
	TSharedPtr<SH2URelativeBox> MyRelativeBox;

	/** Pushes the UPROPERTY values into the Slate widget; one layout invalidation per call. */
	void ApplyLayoutRule();
};
