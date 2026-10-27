// Copyright (c) 2026 FPVSkyline. MIT License.

#include "H2URelativeBox.h"

#include "Components/PanelSlot.h"
#include "Components/Widget.h"
#include "Html2UMGRuntimeLog.h"
#include "Layout/ArrangedChildren.h"
#include "Layout/Geometry.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SNullWidget.h"

#define LOCTEXT_NAMESPACE "Html2UMGRuntime"

namespace
{
	/** Resolve one axis: percentage of the allotted space, else the child's desired size; then clamp. */
	float ResolveAxis(const float Allotted, const float Percent, const float MinPx, const float MaxPx, const float Desired)
	{
		// No rule at all on this axis: behave like a normal panel (the child gets the whole space),
		// so a box whose layout properties were never set cannot silently shrink its content.
		if (Percent <= 0.0f && MinPx <= 0.0f && MaxPx <= 0.0f)
		{
			return Allotted;
		}

		float Size = Desired;
		if (Percent > 0.0f)
		{
			Size = Allotted * Percent;
		}
		if (MinPx > 0.0f)
		{
			Size = FMath::Max(Size, MinPx);
		}
		if (MaxPx > 0.0f)
		{
			Size = FMath::Min(Size, MaxPx);
		}
		return FMath::Max(0.0f, Size);
	}

	/** Pixel clamps only - what an Auto slot (no allotted space for a percentage) can honour. */
	float ClampAxis(const float Desired, const float MinPx, const float MaxPx)
	{
		float Size = Desired;
		if (MinPx > 0.0f)
		{
			Size = FMath::Max(Size, MinPx);
		}
		if (MaxPx > 0.0f)
		{
			Size = FMath::Min(Size, MaxPx);
		}
		return FMath::Max(0.0f, Size);
	}
}

/**
 * Slate half of UH2URelativeBox. SCompoundWidget (a panel with exactly one slot) is the right base
 * here: the arrange rule is fully custom, so there is nothing to inherit beyond the slot holder.
 */
class SH2URelativeBox : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SH2URelativeBox)
		: _WidthPercent(0.0f)
		, _MinWidth(0.0f)
		, _MaxWidth(0.0f)
		, _HeightPercent(0.0f)
		, _MinHeight(0.0f)
		, _MaxHeight(0.0f)
		, _HAlign(0.5f)
		, _VAlign(0.5f)
		, _Padding(FMargin(0.0f))
	{
	}

		SLATE_DEFAULT_SLOT(FArguments, Content)

		SLATE_ARGUMENT(float, WidthPercent)
		SLATE_ARGUMENT(float, MinWidth)
		SLATE_ARGUMENT(float, MaxWidth)
		SLATE_ARGUMENT(float, HeightPercent)
		SLATE_ARGUMENT(float, MinHeight)
		SLATE_ARGUMENT(float, MaxHeight)
		SLATE_ARGUMENT(float, HAlign)
		SLATE_ARGUMENT(float, VAlign)
		SLATE_ARGUMENT(FMargin, Padding)
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs)
	{
		ChildSlot[InArgs._Content.Widget];
		SetLayoutRule(InArgs._WidthPercent, InArgs._MinWidth, InArgs._MaxWidth,
			InArgs._HeightPercent, InArgs._MinHeight, InArgs._MaxHeight,
			InArgs._HAlign, InArgs._VAlign, InArgs._Padding);
	}

	/** Replaces the single child (UMG calls this while rebuilding). */
	void SetContent(const TSharedRef<SWidget>& InContent)
	{
		ChildSlot.AttachWidget(InContent);
		ContentWidget = InContent;
	}

	bool HasContent() const
	{
		// Tracked explicitly: ChildSlot::GetWidget() never returns null (an empty slot yields
		// SNullWidget), so a TWeakPtr is the cheap way to answer "is there a real child yet".
		return ContentWidget.IsValid();
	}

	void SetLayoutRule(float InWidthPercent, float InMinWidth, float InMaxWidth,
		float InHeightPercent, float InMinHeight, float InMaxHeight,
		float InHAlign, float InVAlign, const FMargin& InPadding)
	{
		const bool bChanged = WidthPercent != InWidthPercent || MinWidth != InMinWidth || MaxWidth != InMaxWidth
			|| HeightPercent != InHeightPercent || MinHeight != InMinHeight || MaxHeight != InMaxHeight
			|| HAlign != InHAlign || VAlign != InVAlign || Padding != InPadding;

		WidthPercent = InWidthPercent;
		MinWidth = InMinWidth;
		MaxWidth = InMaxWidth;
		HeightPercent = InHeightPercent;
		MinHeight = InMinHeight;
		MaxHeight = InMaxHeight;
		HAlign = FMath::Clamp(InHAlign, 0.0f, 1.0f);
		VAlign = FMath::Clamp(InVAlign, 0.0f, 1.0f);
		Padding = InPadding;

		if (bChanged)
		{
			Invalidate(EInvalidateWidgetReason::Layout);
		}
	}

	virtual FVector2D ComputeDesiredSize(float LayoutScaleMultiplier) const override
	{
		// SWidget::GetDesiredSize() takes no argument in UE 5.8 (it is cached from the last prepass).
		const FVector2D Desired = ChildSlot.GetWidget()->GetDesiredSize();

		// No allotted space here, so a percentage has nothing to resolve against: an Auto slot sees
		// the clamps only (this is what keeps a min-width box from collapsing).
		const FVector2D Clamped(ClampAxis(Desired.X, MinWidth, MaxWidth), ClampAxis(Desired.Y, MinHeight, MaxHeight));
		// FMargin::GetDesiredSize() returns a deprecation wrapper, so add the components directly.
		return Clamped + FVector2D(Padding.Left + Padding.Right, Padding.Top + Padding.Bottom);
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
		const FVector2D InnerSize(
			FMath::Max(0.0f, AllottedSize.X - Pad.GetTotalSpaceAlong<Orient_Horizontal>()),
			FMath::Max(0.0f, AllottedSize.Y - Pad.GetTotalSpaceAlong<Orient_Vertical>()));

		const FVector2D Desired = Child->GetDesiredSize();
		const float ChildW = ResolveAxis(InnerSize.X, WidthPercent, MinWidth, MaxWidth, Desired.X);
		const float ChildH = ResolveAxis(InnerSize.Y, HeightPercent, MinHeight, MaxHeight, Desired.Y);

		// Alignment is a fraction of the leftover space: 0 = left/top, 0.5 = centre, 1 = right/bottom.
		// This deliberately ignores the child's own slot alignment (a converter slot is usually
		// HAlign_Fill, and Fill would otherwise stretch the child over the percentage we just resolved).
		const float OffsetX = (InnerSize.X - ChildW) * HAlign;
		const float OffsetY = (InnerSize.Y - ChildH) * VAlign;

		const FVector2D ChildOffset(OffsetX + Pad.Left, OffsetY + Pad.Top);
		ArrangedChildren.AddWidget(AllottedGeometry.MakeChild(Child, ChildOffset, FVector2D(ChildW, ChildH)));
	}

private:
	TWeakPtr<SWidget> ContentWidget;
	float WidthPercent = 0.0f;
	float MinWidth = 0.0f;
	float MaxWidth = 0.0f;
	float HeightPercent = 0.0f;
	float MinHeight = 0.0f;
	float MaxHeight = 0.0f;
	float HAlign = 0.5f;
	float VAlign = 0.5f;
	FMargin Padding = FMargin(0.0f);
};

UH2URelativeBox::UH2URelativeBox(const FObjectInitializer& ObjectInitializer)
	: Super(ObjectInitializer)
{
}

TSharedRef<SWidget> UH2URelativeBox::RebuildWidget()
{
	MyRelativeBox = SNew(SH2URelativeBox);

	for (UPanelSlot* PanelSlot : Slots)
	{
		if (PanelSlot && PanelSlot->Content && !MyRelativeBox->HasContent())
		{
			MyRelativeBox->SetContent(PanelSlot->Content->TakeWidget());
		}
	}

	ApplyLayoutRule();
	return MyRelativeBox.ToSharedRef();
}

void UH2URelativeBox::SynchronizeProperties()
{
	Super::SynchronizeProperties();
	ApplyLayoutRule();
}

void UH2URelativeBox::ApplyLayoutRule()
{
	if (!MyRelativeBox.IsValid())
	{
		return;
	}

	MyRelativeBox->SetLayoutRule(WidthPercent, MinWidth, MaxWidth, HeightPercent, MinHeight, MaxHeight,
		ContentHAlign, ContentVAlign, ContentPadding);
}

void UH2URelativeBox::ReleaseSlateResources(bool bReleaseChildren)
{
	Super::ReleaseSlateResources(bReleaseChildren);
	MyRelativeBox.Reset();
}

void UH2URelativeBox::OnSlotAdded(UPanelSlot* InSlot)
{
	if (InSlot && InSlot->Content && MyRelativeBox.IsValid() && !MyRelativeBox->HasContent())
	{
		MyRelativeBox->SetContent(InSlot->Content->TakeWidget());
	}

	if (InSlot && Slots.Num() > 1)
	{
		// Single-child box: say so instead of silently dropping the extra slot during arrange.
		UE_LOG(LogHtml2UMGRuntime, Warning,
			TEXT("H2URelativeBox '%s' has more than one child; only the first is laid out."), *GetName());
	}
}

void UH2URelativeBox::OnSlotRemoved(UPanelSlot* InSlot)
{
	if (MyRelativeBox.IsValid() && Slots.Num() == 0)
	{
		MyRelativeBox->SetContent(SNullWidget::NullWidget);
	}
}

#if WITH_EDITOR
const FText UH2URelativeBox::GetPaletteCategory()
{
	return LOCTEXT("Html2UMG", "Html2UMG");
}
#endif

#undef LOCTEXT_NAMESPACE
