// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Components/PanelWidget.h"
#include "H2UTextWrapBox.generated.h"

class SH2UTextWrapBox;

/**
 * Gives its single child (normally a UTextBlock) a REAL width at layout time, so text re-wraps as
 * the container resizes. This is the one thing UMG cannot do for a paragraph in a VerticalBox:
 *
 *   SVerticalBox asks every child for its desired size WITHOUT a width,
 *   so a text block with AutoWrapText but WrapTextAt == 0 measures itself as ONE line,
 *   the Automatic slot then hands it exactly that height, and every wrapped line is clipped.
 *
 * The box therefore sets the child text block's WrapTextAt to its own allotted width (minus
 * ContentPadding) and re-measures it before arranging, so the arranged height matches the wraps
 * that actually happen.
 *
 * Known trade-off, stated explicitly: Slate computes desired sizes before it arranges, so the very
 * first prepass has no allotted width yet. It falls back to DesignWrapWidth (set it from the
 * converter's measurement viewport). After the first arrange the box remembers the real width, so
 * a later resize is picked up by the NEXT layout pass - i.e. a resize can be one frame late. Static
 * UI never shows it; a window drag may show one frame of the previous wrap.
 *
 * If the child is not a text block (an image, a nested panel, ...) the box behaves like a plain
 * single-child panel: the child gets the full allotted space.
 */
UCLASS(BlueprintType, Blueprintable, meta = (DisplayName = "Text Wrap Box"))
class HTML2UMGRUNTIME_API UH2UTextWrapBox : public UPanelWidget
{
	GENERATED_BODY()

public:
	explicit UH2UTextWrapBox(const FObjectInitializer& ObjectInitializer);

	/** Space kept free around the child (CSS padding on the paragraph box). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Text Wrap Box")
	FMargin ContentPadding;

	/**
	 * Wrap width used for the FIRST layout pass, before any arrange happened. 0 = fall back to the
	 * child's own desired size (one line for an unwrapped paragraph). The converter should set this
	 * to the width the paragraph had in the responsive design viewport.
	 */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Text Wrap Box")
	float DesignWrapWidth = 0.0f;

	/** Force AutoWrapText on the child text block (a paragraph on one line is almost never wanted). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Text Wrap Box")
	bool bAutoWrap = true;

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
	TSharedPtr<SH2UTextWrapBox> MyTextWrapBox;

	void ApplyLayoutRule();
};
