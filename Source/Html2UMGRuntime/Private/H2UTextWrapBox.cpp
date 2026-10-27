// Copyright (c) 2026 FPVSkyline. MIT License.

#include "H2UTextWrapBox.h"

#include "Components/PanelSlot.h"
#include "Components/TextBlock.h"
#include "Components/Widget.h"
#include "Html2UMGRuntimeLog.h"
#include "Layout/ArrangedChildren.h"
#include "Layout/Geometry.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SNullWidget.h"
#include "Widgets/Text/STextBlock.h"

#define LOCTEXT_NAMESPACE "Html2UMGRuntime"

/**
 * Slate half of UH2UTextWrapBox.
 *
 * Arrange runs with the real allotted width, so that is where the wrap width is decided. The child
 * is re-measured right there (SlatePrepass) instead of waiting for the next prepass: otherwise the
 * arranged height comes from the un-wrapped desired size and the extra lines are clipped.
 * ComputeDesiredSize uses the width from the previous arrange (or DesignWrapWidth on the first
 * pass) for the same reason - an Automatic slot in a VerticalBox takes the height from here.
 */
class SH2UTextWrapBox : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SH2UTextWrapBox)
		: _Padding(FMargin(0.0f))
		, _DesignWrapWidth(0.0f)
		, _AutoWrap(true)
	{
	}

		SLATE_DEFAULT_SLOT(FArguments, Content)

		SLATE_ARGUMENT(FMargin, Padding)
		SLATE_ARGUMENT(float, DesignWrapWidth)
		SLATE_ARGUMENT(bool, AutoWrap)
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs)
	{
		// NOTE: InArgs._Content.Widget is a TAlwaysValidWidget, i.e. it defaults to
		// SNullWidget::NullWidget and is ALWAYS a valid pointer. Treating it as "content" makes
		// HasContent() true and stops the UMG wrapper from ever attaching the real child, which is
		// why an earlier revision laid out an empty SNullWidget forever (w/h 0, painted=false).
		// Content is only ever set through SetContent(), called by UH2UTextWrapBox::RebuildWidget.
		ChildSlot[InArgs._Content.Widget];
		ContentWidget = nullptr;
		bHasContent = false;
		Padding = InArgs._Padding;
		DesignWrapWidth = InArgs._DesignWrapWidth;
		bAutoWrap = InArgs._AutoWrap;
	}

	/**
	 * bInIsTextBlock comes from the UObject side (UTextBlock::IsA), so the cast below is exact and
	 * an arbitrary child widget is never cast to STextBlock.
	 */
	void SetContent(const TSharedRef<SWidget>& InContent, bool bInIsTextBlock)
	{
		ChildSlot.AttachWidget(InContent);
		ContentWidget = InContent;
		bHasContent = true;
		CachedTextBlock.Reset();
		AppliedWrapWidth = -1.0f;
		bChildIsTextBlock = bInIsTextBlock;
	}

	bool HasContent() const
	{
		// A flag, not ContentWidget.IsValid(): the default slot widget is SNullWidget, which is valid.
		return bHasContent;
	}

	void SetLayoutRule(const FMargin& InPadding, float InDesignWrapWidth, bool bInAutoWrap)
	{
		const bool bChanged = Padding != InPadding
			|| !FMath::IsNearlyEqual(DesignWrapWidth, InDesignWrapWidth)
			|| bAutoWrap != bInAutoWrap;

		Padding = InPadding;
		DesignWrapWidth = InDesignWrapWidth;
		bAutoWrap = bInAutoWrap;

		if (bChanged)
		{
			Invalidate(EInvalidateWidgetReason::Layout);
		}
	}

	virtual FVector2D ComputeDesiredSize(float LayoutScaleMultiplier) const override
	{
		const TSharedPtr<SWidget> Child = bHasContent ? ContentWidget.Pin() : nullptr;

		// One-off diagnostic: tells "no child attached" apart from "child measured 0". Bounded so a
		// perf-sensitive game log stays quiet.
		static int32 DiagnosticCount = 0;
		if (DiagnosticCount < 5)
		{
			++DiagnosticCount;
			UE_LOG(LogHtml2UMGRuntime, Warning,
				TEXT("H2UTextWrapBox diagnostic: has=%d measured=%.1f design=%.1f childDesiredH=%.1f"),
				bHasContent ? 1 : 0, MeasuredWidth, DesignWrapWidth,
				Child.IsValid() ? Child->GetDesiredSize().Y : -1.0f);
		}

		if (!Child.IsValid())
		{
			return FVector2D(Padding.Left + Padding.Right, Padding.Top + Padding.Bottom);
		}

		// Wrap at the width we last saw (or the design width on the very first pass), so the height
		// reported to the parent already accounts for the lines that will really be there.
		const float WrapWidth = MeasuredWidth > 0.0f ? MeasuredWidth : DesignWrapWidth;
		if (WrapWidth > 0.0f && ApplyWrapWidth(WrapWidth))
		{
			Child->SlatePrepass(LayoutScaleMultiplier);
		}

		const FVector2D Desired = Child->GetDesiredSize();
		ReportedChildHeight = Desired.Y;
		return FVector2D(Desired.X + Padding.Left + Padding.Right, Desired.Y + Padding.Top + Padding.Bottom);
	}

	virtual void OnArrangeChildren(const FGeometry& AllottedGeometry, FArrangedChildren& ArrangedChildren) const override
	{
		const TSharedRef<SWidget> Child = ChildSlot.GetWidget();
		if (!ArrangedChildren.Accepts(Child->GetVisibility()))
		{
			return;
		}

		const FVector2D AllottedSize = AllottedGeometry.GetLocalSize();
		const FMargin Pad = Padding;
		const float InnerWidth = FMath::Max(0.0f, AllottedSize.X - Pad.GetTotalSpaceAlong<Orient_Horizontal>());
		const float InnerHeight = FMath::Max(0.0f, AllottedSize.Y - Pad.GetTotalSpaceAlong<Orient_Vertical>());

		const bool bWidthChanged = !FMath::IsNearlyEqual(InnerWidth, MeasuredWidth, 0.01f);
		MeasuredWidth = InnerWidth;

		if (ApplyWrapWidth(InnerWidth) || bWidthChanged)
		{
			// Re-measure at the real width before deciding the height; that is the whole point of this
			// widget. Safe here: the child's prepass is independent of ours and only re-runs because
			// SetWrapTextAt invalidated it.
			Child->SlatePrepass(AllottedGeometry.Scale);
		}

		// A text block gets its measured height (which may exceed the slot - that is the caller's
		// Automatic-slot problem, fixed by ComputeDesiredSize once a width is known). Anything else
		// behaves like a plain panel.
		const float ChildHeight = bChildIsTextBlock ? FMath::Max(0.0f, Child->GetDesiredSize().Y) : InnerHeight;

		// First arrange (or a resize) can change the wrapped height after the desired-size pass that
		// the parent already consumed. Tell the parent to ask again next frame, otherwise an
		// Automatic slot keeps the height of the previous (or design) width - the "text overlaps the
		// card below it" case when no DesignWrapWidth hint was provided. It converges after one
		// invalidation: the next ComputeDesiredSize uses MeasuredWidth, so the values agree.
		if (bChildIsTextBlock
			&& ReportedChildHeight >= 0.0f
			&& !FMath::IsNearlyEqual(ChildHeight, ReportedChildHeight, 0.5f))
		{
			ReportedChildHeight = ChildHeight;
			// Prepass (not just Layout): that is what forces this widget's ComputeDesiredSize to run
			// again on the next pass, both through the fast-path invalidation root and through a plain
			// SlatePrepass walk.
			const_cast<SH2UTextWrapBox*>(this)->Invalidate(EInvalidateWidgetReason::Prepass);
		}

		ArrangedChildren.AddWidget(AllottedGeometry.MakeChild(
			Child, FVector2D(Pad.Left, Pad.Top), FVector2D(InnerWidth, ChildHeight)));
	}

private:
	/** Sets WrapTextAt/AutoWrapText on the child text block. Returns true when the width changed. */
	bool ApplyWrapWidth(float Width) const
	{
		if (!bAutoWrap)
		{
			return false;
		}

		const TSharedPtr<STextBlock> TextBlock = GetCachedTextBlock();
		if (!TextBlock.IsValid())
		{
			return false;
		}

		if (FMath::IsNearlyEqual(Width, AppliedWrapWidth, 0.01f))
		{
			return false;
		}

		AppliedWrapWidth = Width;
		TextBlock->SetAutoWrapText(true);
		TextBlock->SetWrapTextAt(Width);
		return true;
	}

	TSharedPtr<STextBlock> GetCachedTextBlock() const
	{
		if (!bChildIsTextBlock)
		{
			return nullptr;
		}

		if (CachedTextBlock.IsValid())
		{
			return CachedTextBlock;
		}

		if (bHasContent)
		{
			if (const TSharedPtr<SWidget> Child = ContentWidget.Pin())
			{
				// Exact by construction: the UObject only marks text blocks, and a UTextBlock always
				// builds an STextBlock (UTextBlock::RebuildWidget). Slate has no RTTI here.
				CachedTextBlock = StaticCastSharedPtr<STextBlock>(Child);
				return CachedTextBlock;
			}
		}
		return nullptr;
	}

private:
	TWeakPtr<SWidget> ContentWidget;
	// Strong: the box owns its child slot anyway, and a weak ptr would need Pin() on every use.
	mutable TSharedPtr<STextBlock> CachedTextBlock;
	bool bChildIsTextBlock = false;
	bool bHasContent = false;
	mutable float AppliedWrapWidth = -1.0f;
	mutable float MeasuredWidth = -1.0f;
	/** Height we last returned from ComputeDesiredSize; -1 before the first pass. */
	mutable float ReportedChildHeight = -1.0f;
	FMargin Padding = FMargin(0.0f);
	float DesignWrapWidth = 0.0f;
	bool bAutoWrap = true;
};

UH2UTextWrapBox::UH2UTextWrapBox(const FObjectInitializer& ObjectInitializer)
	: Super(ObjectInitializer)
{
}

TSharedRef<SWidget> UH2UTextWrapBox::RebuildWidget()
{
	MyTextWrapBox = SNew(SH2UTextWrapBox);

	// Attach unconditionally (first slot wins). Do not gate this on HasContent(): the Slate side
	// starts with SNullWidget, and a bad "already has content" answer leaves the tree empty.
	bool bAttached = false;
	for (UPanelSlot* PanelSlot : Slots)
	{
		if (PanelSlot && PanelSlot->Content && !bAttached)
		{
			MyTextWrapBox->SetContent(PanelSlot->Content->TakeWidget(), PanelSlot->Content->IsA<UTextBlock>());
			bAttached = true;
		}
	}

	ApplyLayoutRule();
	return MyTextWrapBox.ToSharedRef();
}

void UH2UTextWrapBox::SynchronizeProperties()
{
	Super::SynchronizeProperties();
	ApplyLayoutRule();
}

void UH2UTextWrapBox::ApplyLayoutRule()
{
	if (MyTextWrapBox.IsValid())
	{
		MyTextWrapBox->SetLayoutRule(ContentPadding, DesignWrapWidth, bAutoWrap);
	}
}

void UH2UTextWrapBox::ReleaseSlateResources(bool bReleaseChildren)
{
	Super::ReleaseSlateResources(bReleaseChildren);
	MyTextWrapBox.Reset();
}

void UH2UTextWrapBox::OnSlotAdded(UPanelSlot* InSlot)
{
	if (InSlot && InSlot->Content && MyTextWrapBox.IsValid())
	{
		if (!MyTextWrapBox->HasContent())
		{
			MyTextWrapBox->SetContent(InSlot->Content->TakeWidget(), InSlot->Content->IsA<UTextBlock>());
		}
		// The widget may have been built before its child existed (designer, late AddChild), so make
		// sure the new content is actually laid out on the next frame.
		InvalidateLayoutAndVolatility();
	}

	if (InSlot && Slots.Num() > 1)
	{
		UE_LOG(LogHtml2UMGRuntime, Warning,
			TEXT("H2UTextWrapBox '%s' has more than one child; only the first is laid out."), *GetName());
	}
}

void UH2UTextWrapBox::OnSlotRemoved(UPanelSlot* InSlot)
{
	if (MyTextWrapBox.IsValid() && Slots.Num() == 0)
	{
		MyTextWrapBox->SetContent(SNullWidget::NullWidget, /*bInIsTextBlock=*/false);
		InvalidateLayoutAndVolatility();
	}
}

#if WITH_EDITOR
const FText UH2UTextWrapBox::GetPaletteCategory()
{
	return LOCTEXT("Html2UMG", "Html2UMG");
}
#endif

#undef LOCTEXT_NAMESPACE
