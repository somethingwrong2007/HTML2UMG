// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Components/WrapBox.h"
#include "H2UWrapBox.generated.h"

class SH2UWrapBox;

/**
 * A WrapBox whose DESIRED size is computed for the width it will actually be given.
 *
 * The stock UWrapBox has a hole here: SWrapBox wraps when a child would pass
 * PreferredSize.Get() (SWrapBox.cpp FChildArranger), and with bExplicitWrapSize=false the
 * "allotted size" mode only copies the allotted width into PreferredSize during Tick - i.e. one
 * frame late. In a VerticalBox's Automatic slot the first (and in an offscreen render only)
 * desired-size pass therefore sees WrapSize == 0, every child is counted on its own line, and the
 * container reports a height several times too tall (measured: 12-responsive Cards 1226 instead of
 * 458; 01-flex Tags 184 instead of 24).
 *
 * This box feeds the real width into the wrap size on BOTH passes:
 *   - OnArrangeChildren: wrap at the allotted width, then re-measure and, if the height changed,
 *     invalidate Prepass so the parent asks again next frame (converges after one pass);
 *   - ComputeDesiredSize: wrap at the width seen during the previous arrange, or DesignWrapWidth on
 *     the very first pass (the converter should send the design content width).
 *
 * Slots stay UWrapBoxSlot (Padding / FillSpanWhenLessThan / HAlign / VAlign / FillEmptySpace /
 * ForceNewLine all work), and InnerSlotPadding / HorizontalAlignment / Orientation are inherited.
 */
UCLASS(BlueprintType, Blueprintable, meta = (DisplayName = "H2U Wrap Box"))
class HTML2UMGRUNTIME_API UH2UWrapBox : public UWrapBox
{
	GENERATED_BODY()

public:
	/**
	 * Wrap width used for the first layout pass, before any arrange happened. 0 = whatever the
	 * inherited WrapSize says (the engine default, 500). The converter should set the width the
	 * container had in the responsive design viewport.
	 */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Wrap Box")
	float DesignWrapWidth = 0.0f;

	//~ Begin UWidget interface
	virtual TSharedRef<SWidget> RebuildWidget() override;
	virtual void SynchronizeProperties() override;
	virtual void ReleaseSlateResources(bool bReleaseChildren) override;
#if WITH_EDITOR
	virtual const FText GetPaletteCategory() override;
#endif
	//~ End UWidget interface

protected:
	/** Same object as UWrapBox::MyWrapBox, kept typed so we can talk to SH2UWrapBox. */
	TSharedPtr<SH2UWrapBox> MyDynamicWrap;
};
