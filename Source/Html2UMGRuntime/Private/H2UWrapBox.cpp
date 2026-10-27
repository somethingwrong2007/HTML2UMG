// Copyright (c) 2026 FPVSkyline. MIT License.

#include "H2UWrapBox.h"

#include "Components/WrapBoxSlot.h"
#include "Html2UMGRuntimeLog.h"
#include "Layout/ArrangedChildren.h"
#include "Layout/Geometry.h"
#include "Widgets/Layout/SWrapBox.h"

#define LOCTEXT_NAMESPACE "Html2UMGRuntime"

/**
 * SWrapBox whose PreferredSize (the width FChildArranger wraps at) is driven by the width this
 * widget is really given, not by a design-time constant or by the one-frame-late Tick copy.
 */
class SH2UWrapBox : public SWrapBox
{
public:
	SLATE_BEGIN_ARGS(SH2UWrapBox)
		: _DesignWrapWidth(0.0f)
	{
	}

		SLATE_ARGUMENT(float, DesignWrapWidth)
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs)
	{
		DesignWrapWidth = InArgs._DesignWrapWidth;

		// We own PreferredSize; letting the allotted-size Tick write it would fight the value we set
		// per pass and reintroduce the one-frame lag this widget exists to remove.
		SetUseAllottedSize(false);
	}

	void SetDesignWrapWidth(float InDesignWrapWidth)
	{
		if (!FMath::IsNearlyEqual(DesignWrapWidth, InDesignWrapWidth))
		{
			DesignWrapWidth = InDesignWrapWidth;
			Invalidate(EInvalidateWidgetReason::Prepass);
		}
	}

	virtual FVector2D ComputeDesiredSize(float LayoutScaleMultiplier) const override
	{
		// First pass: the design width is the only width we can know. Later passes use the width the
		// parent actually allotted, so the reported height matches the wrapping that will happen.
		const double WrapWidth = MeasuredWidth > 0.0f ? MeasuredWidth : DesignWrapWidth;
		if (WrapWidth > 0.0f)
		{
			const_cast<SH2UWrapBox*>(this)->SetWrapSize(static_cast<float>(WrapWidth));
		}

		const FVector2D Desired = SWrapBox::ComputeDesiredSize(LayoutScaleMultiplier);
		ReportedDesiredHeight = Desired.Y;
		return Desired;
	}

	virtual void OnArrangeChildren(const FGeometry& AllottedGeometry, FArrangedChildren& ArrangedChildren) const override
	{
		const float AllottedWidth = AllottedGeometry.GetLocalSize().X;
		MeasuredWidth = AllottedWidth;

		// Wrap at the real width for this frame ...
		const_cast<SH2UWrapBox*>(this)->SetWrapSize(AllottedWidth);
		SWrapBox::OnArrangeChildren(AllottedGeometry, ArrangedChildren);

		// ... then check whether that changed the height the parent already consumed. Fresh.Y can be
		// LARGER than what we reported (the real width is narrower than the width we measured with) or
		// smaller (wider); both are a real change, so the comparison is deliberately direction-less.
		// If it did change, ask for another prepass: ComputeDesiredSize then runs again with
		// MeasuredWidth == this width and reports the same height this arrange produced, so it
		// converges after exactly one invalidation.
		const FVector2D Fresh = SWrapBox::ComputeDesiredSize(AllottedGeometry.Scale);
		const bool bHeightChanged = !FMath::IsNearlyEqual(Fresh.Y, ReportedDesiredHeight, 0.5f);
		if (bHeightChanged)
		{
			ReportedDesiredHeight = Fresh.Y;
			const_cast<SH2UWrapBox*>(this)->Invalidate(EInvalidateWidgetReason::Prepass);
		}

		// Bounded diagnostic: makes a single-frame render easy to classify. On pass 1 the reported
		// height comes from DesignWrapWidth; only a second pass can report the real width's height.
		static int32 DiagnosticCount = 0;
		if (DiagnosticCount < 6)
		{
			++DiagnosticCount;
			UE_LOG(LogHtml2UMGRuntime, Warning,
				TEXT("H2UWrapBox diagnostic: allotted=%.1f measured=%.1f design=%.1f reported=%.1f fresh=%.1f changed=%d"),
				AllottedWidth, MeasuredWidth, DesignWrapWidth, ReportedDesiredHeight, Fresh.Y, bHeightChanged ? 1 : 0);
		}
	}

private:
	float DesignWrapWidth = 0.0f;
	mutable float MeasuredWidth = -1.0f;
	mutable float ReportedDesiredHeight = -1.0f;
};

TSharedRef<SWidget> UH2UWrapBox::RebuildWidget()
{
	// Same construction as UWrapBox::RebuildWidget, but with our subclass and UseAllottedSize off.
	// The shared SWrapBox arguments are set through setters instead of SNew(): our FArguments only
	// declares DesignWrapWidth (a SLATE_BEGIN_ARGS block does not inherit the base widget's args).
	MyDynamicWrap = SNew(SH2UWrapBox).DesignWrapWidth(DesignWrapWidth);
	MyDynamicWrap->SetInnerSlotPadding(GetInnerSlotPadding());
	MyDynamicWrap->SetWrapSize(DesignWrapWidth > 0.0f ? DesignWrapWidth : GetWrapSize());
	MyDynamicWrap->SetHorizontalAlignment(GetHorizontalAlignment());
	MyDynamicWrap->SetOrientation(GetOrientation());
	MyWrapBox = MyDynamicWrap;

	for (UPanelSlot* PanelSlot : Slots)
	{
		if (UWrapBoxSlot* TypedSlot = Cast<UWrapBoxSlot>(PanelSlot))
		{
			TypedSlot->Parent = this;
			TypedSlot->BuildSlot(MyWrapBox.ToSharedRef());
		}
	}

	return MyWrapBox.ToSharedRef();
}

void UH2UWrapBox::SynchronizeProperties()
{
	Super::SynchronizeProperties();

	if (!MyDynamicWrap.IsValid())
	{
		return;
	}

	// Super pushed UseAllottedSize(!bExplicitWrapSize); take the wrap width back under our control.
	MyDynamicWrap->SetUseAllottedSize(false);
	MyDynamicWrap->SetDesignWrapWidth(DesignWrapWidth);
	MyDynamicWrap->SetWrapSize(DesignWrapWidth > 0.0f ? DesignWrapWidth : GetWrapSize());
	InvalidateLayoutAndVolatility();
}

void UH2UWrapBox::ReleaseSlateResources(bool bReleaseChildren)
{
	Super::ReleaseSlateResources(bReleaseChildren);
	MyDynamicWrap.Reset();
}

#if WITH_EDITOR
const FText UH2UWrapBox::GetPaletteCategory()
{
	return LOCTEXT("Html2UMG", "Html2UMG");
}
#endif

#undef LOCTEXT_NAMESPACE
