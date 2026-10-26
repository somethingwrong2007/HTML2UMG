// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Importer/Html2UMGWidgetBuilder.h"

#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetTree.h"
#include "Components/Button.h"
#include "Components/ContentWidget.h"
#include "Components/NamedSlot.h"
#include "Components/NamedSlotInterface.h"
#include "Components/PanelSlot.h"
#include "Components/PanelWidget.h"
#include "Components/Widget.h"
#include "Dom/JsonValue.h"
#include "Html2UMGLog.h"
#include "Misc/PackageName.h"
#include "UObject/Class.h"
#include "UObject/UObjectHash.h"

namespace
{
	constexpr int32 kMaxTreeDepth = 64;

	int32 EditDistance(const FString& A, const FString& B)
	{
		const int32 LengthA = A.Len();
		const int32 LengthB = B.Len();
		if (LengthA == 0)
		{
			return LengthB;
		}
		if (LengthB == 0)
		{
			return LengthA;
		}

		TArray<int32> Previous;
		TArray<int32> Current;
		Previous.SetNum(LengthB + 1);
		Current.SetNum(LengthB + 1);

		for (int32 Index = 0; Index <= LengthB; ++Index)
		{
			Previous[Index] = Index;
		}

		for (int32 Row = 1; Row <= LengthA; ++Row)
		{
			Current[0] = Row;
			for (int32 Column = 1; Column <= LengthB; ++Column)
			{
				const int32 Cost = (A[Row - 1] == B[Column - 1]) ? 0 : 1;
				Current[Column] = FMath::Min3(
					Previous[Column] + 1,
					Current[Column - 1] + 1,
					Previous[Column - 1] + Cost);
			}
			Previous = Current;
		}

		return Previous[LengthB];
	}

	/** Every concrete UWidget subclass that is currently loaded. */
	void GatherWidgetClasses(TArray<UClass*>& OutClasses)
	{
		OutClasses.Reset();
		GetDerivedClasses(UWidget::StaticClass(), OutClasses, true);
		OutClasses.Add(UWidget::StaticClass());
	}

	/** Reads a numeric member of a JSON object (case-insensitive key lookup is not needed: contract keys are canonical). */
	bool TryGetNumber(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field, double& OutValue)
	{
		if (!Object.IsValid())
		{
			return false;
		}

		const TSharedPtr<FJsonValue> Value = Object->TryGetField(Field);
		return Value.IsValid() && Value->TryGetNumber(OutValue);
	}

	FVector2D ReadSizeFromArray(const TSharedPtr<FJsonValue>& Value)
	{
		if (!Value.IsValid() || Value->Type != EJson::Array)
		{
			return FVector2D::ZeroVector;
		}

		const TArray<TSharedPtr<FJsonValue>>& Items = Value->AsArray();
		double X = 0.0;
		double Y = 0.0;
		if (Items.Num() >= 2 && Items[0].IsValid() && Items[1].IsValid()
			&& Items[0]->TryGetNumber(X) && Items[1]->TryGetNumber(Y))
		{
			return FVector2D(X, Y);
		}

		return FVector2D::ZeroVector;
	}
}

FHtml2UMGWidgetBuilder::FHtml2UMGWidgetBuilder(
	UWidgetTree& InWidgetTree,
	FHtml2UMGAssetImport& InAssets,
	const FH2UImportOptions& InOptions,
	const FVector2D& InDesignViewport)
	: Tree(InWidgetTree)
	, Assets(InAssets)
	, Options(InOptions)
	, DesignViewport(InDesignViewport)
{
}

void FHtml2UMGWidgetBuilder::Message(const TCHAR* Severity, const FString& Text)
{
	if (Sink)
	{
		Sink(FH2UMessage(Severity, Text));
	}

	if (FString(Severity).Equals(TEXT("error"), ESearchCase::IgnoreCase))
	{
		UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG: %s"), *Text);
	}
	else if (FString(Severity).Equals(TEXT("warning"), ESearchCase::IgnoreCase))
	{
		UE_LOG(LogHtml2UMG, Warning, TEXT("Html2UMG: %s"), *Text);
	}
	else
	{
		UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG: %s"), *Text);
	}
}

FString FHtml2UMGWidgetBuilder::NodeContext(const FH2UNode& Node) const
{
	if (Node.Source.IsEmpty())
	{
		return FString::Printf(TEXT("node '%s'"), *Node.Name);
	}
	return FString::Printf(TEXT("node '%s' (from %s)"), *Node.Name, *Node.Source);
}

FString FHtml2UMGWidgetBuilder::SuggestWidgetClass(const FString& ClassName)
{
	if (ClassName.IsEmpty())
	{
		return FString();
	}

	TArray<UClass*> Candidates;
	GatherWidgetClasses(Candidates);

	FString BestName;
	int32 BestDistance = TNumericLimits<int32>::Max();
	for (UClass* Candidate : Candidates)
	{
		if (!Candidate || Candidate->HasAnyClassFlags(CLASS_Abstract))
		{
			continue;
		}

		const FString CandidateName = Candidate->GetName();
		const int32 Distance = EditDistance(ClassName.ToLower(), CandidateName.ToLower());
		if (Distance < BestDistance)
		{
			BestDistance = Distance;
			BestName = CandidateName;
		}
	}

	const int32 Threshold = FMath::Max(2, ClassName.Len() / 3);
	return (BestDistance <= Threshold) ? BestName : FString();
}

UClass* FHtml2UMGWidgetBuilder::ResolveWidgetClass(const FString& ClassName, FString& OutError)
{
	OutError.Reset();

	const FString Trimmed = ClassName.TrimStartAndEnd();
	if (Trimmed.IsEmpty())
	{
		OutError = TEXT("the node has no class name.");
		return nullptr;
	}

	// 1. Full object path, e.g. "/Script/UMG.TextBlock" or "/Game/UI/WBP_Foo.WBP_Foo_C".
	if (Trimmed.StartsWith(TEXT("/")))
	{
		UClass* Loaded = FindObject<UClass>(nullptr, *Trimmed);
		if (!Loaded)
		{
			Loaded = LoadObject<UClass>(nullptr, *Trimmed);
		}

		if (Loaded)
		{
			if (!Loaded->IsChildOf(UWidget::StaticClass()))
			{
				OutError = FString::Printf(TEXT("class '%s' resolves to %s, which is not a UMG widget (it must derive from UWidget)."),
					*Trimmed, *Loaded->GetName());
				return nullptr;
			}
			return Loaded;
		}

		// A blueprint path may omit the object name: "/Game/UI/WBP_Foo" -> "/Game/UI/WBP_Foo.WBP_Foo_C".
		if (!Trimmed.Contains(TEXT(".")))
		{
			const FString AssetName = FPackageName::GetShortName(Trimmed);
			const FString GeneratedPath = FString::Printf(TEXT("%s.%s_C"), *Trimmed, *AssetName);
			UClass* Generated = LoadObject<UClass>(nullptr, *GeneratedPath);
			if (Generated)
			{
				return Generated;
			}
		}

		OutError = FString::Printf(TEXT("class '%s' could not be loaded."), *Trimmed);
		return nullptr;
	}

	// 2. Short native name -> /Script/UMG.Name, then /Script/Engine.Name.
	static const TCHAR* Modules[] = { TEXT("UMG"), TEXT("Engine") };
	for (const TCHAR* Module : Modules)
	{
		const FString ScriptPath = FString::Printf(TEXT("/Script/%s.%s"), Module, *Trimmed);
		if (UClass* Found = FindObject<UClass>(nullptr, *ScriptPath))
		{
			return Found;
		}
		UClass* Loaded = LoadObject<UClass>(nullptr, *ScriptPath);
		if (Loaded)
		{
			return Loaded;
		}
	}

	// 3. An already-loaded class with that name (blueprint generated classes end in _C).
	if (UClass* Named = FindObject<UClass>(nullptr, *Trimmed))
	{
		if (Named->IsChildOf(UWidget::StaticClass()))
		{
			return Named;
		}
	}

	// 4. Case-insensitive scan of every loaded widget class.
	TArray<UClass*> Candidates;
	GatherWidgetClasses(Candidates);
	for (UClass* Candidate : Candidates)
	{
		if (Candidate && !Candidate->HasAnyClassFlags(CLASS_Abstract) && Candidate->GetName().Equals(Trimmed, ESearchCase::IgnoreCase))
		{
			return Candidate;
		}
	}

	const FString Suggestion = SuggestWidgetClass(Trimmed);
	OutError = Suggestion.IsEmpty()
		? FString::Printf(TEXT("unknown widget class '%s' (expected a UMG short name such as 'TextBlock', or '/Script/UMG.TextBlock')."), *Trimmed)
		: FString::Printf(TEXT("unknown widget class '%s'. Did you mean '%s'?"), *Trimmed, *Suggestion);
	return nullptr;
}

void FHtml2UMGWidgetBuilder::PrepareInPlaceRebuild()
{
	OldWidgets.Reset();
	OldWidgetsByName.Reset();
	ConsumedWidgets.Reset();
	UsedNames.Reset();

	Tree.GetAllWidgets(OldWidgets);
	OldWidgets.RemoveAll([](UWidget* Widget) { return Widget == nullptr; });

	for (UWidget* Widget : OldWidgets)
	{
		OldWidgetsByName.Add(Widget->GetFName(), Widget);
	}

	// Detach every child so the widgets we keep can be re-parented into the new tree.
	for (UWidget* Widget : OldWidgets)
	{
		if (UPanelWidget* Panel = Cast<UPanelWidget>(Widget))
		{
			Panel->ClearChildren();
		}
	}

	Tree.RootWidget = nullptr;
}

void FHtml2UMGWidgetBuilder::PrepareCleanRebuild()
{
	OldWidgets.Reset();
	OldWidgetsByName.Reset();
	ConsumedWidgets.Reset();
	UsedNames.Reset();

	Tree.GetAllWidgets(OldWidgets);
	OldWidgets.RemoveAll([](UWidget* Widget) { return Widget == nullptr; });

	Tree.RootWidget = nullptr;

	for (UWidget* Widget : OldWidgets)
	{
		if (UPanelWidget* Panel = Cast<UPanelWidget>(Widget))
		{
			Panel->ClearChildren();
		}
	}

	for (UWidget* Widget : OldWidgets)
	{
		RetireWidget(Widget);
	}

	OldWidgets.Reset();
}

void FHtml2UMGWidgetBuilder::RetireWidget(UWidget* Widget)
{
	if (!Widget)
	{
		return;
	}

	Tree.RemoveWidget(Widget);

	// Free the canonical name first, so the replacement widget can take it over cleanly.
	const FString RetiredName = FString::Printf(TEXT("%s_H2URetired_%d"), *Widget->GetName(), RetirementCounter++);
	Widget->Rename(*RetiredName, nullptr, REN_DontCreateRedirectors | REN_DoNotDirty | REN_NonTransactional);
	Widget->MarkAsGarbage();
}

void FHtml2UMGWidgetBuilder::RetireUnusedWidgets()
{
	for (UWidget* Widget : OldWidgets)
	{
		if (Widget && !ConsumedWidgets.Contains(Widget))
		{
			RetireWidget(Widget);
		}
	}
}

UWidget* FHtml2UMGWidgetBuilder::AcquireWidget(const FH2UNode& Node, UClass* WidgetClass, FName DesiredName)
{
	if (bRebuildInPlace)
	{
		if (UWidget* const* Existing = OldWidgetsByName.Find(DesiredName))
		{
			UWidget* OldWidget = *Existing;
			if (OldWidget && !ConsumedWidgets.Contains(OldWidget))
			{
				if (OldWidget->GetClass() == WidgetClass)
				{
					ConsumedWidgets.Add(OldWidget);
					++WidgetsReused;
					return OldWidget;
				}

				// Same name, different class: the contract changed, so the old widget has to go.
				ConsumedWidgets.Add(OldWidget);
				RetireWidget(OldWidget);
			}
		}
	}

	FName FinalName = DesiredName;
	int32 Suffix = 1;
	while (UsedNames.Contains(FinalName))
	{
		FinalName = FName(*FString::Printf(TEXT("%s_%d"), *DesiredName.ToString(), Suffix++));
	}
	UsedNames.Add(FinalName);

	UWidget* Widget = Tree.ConstructWidget<UWidget>(WidgetClass, FinalName);
	if (!Widget)
	{
		Error(FString::Printf(TEXT("%s: could not construct %s named '%s'."), *NodeContext(Node), *WidgetClass->GetName(), *FinalName.ToString()));
		return nullptr;
	}

	++WidgetsCreated;
	return Widget;
}

UPanelSlot* FHtml2UMGWidgetBuilder::AttachToParent(UWidget& Widget, UWidget* ParentWidget, const FH2UNode& Node)
{
	if (!ParentWidget)
	{
		if (Node.Slot.IsValid())
		{
			Warn(FString::Printf(TEXT("%s: \"slot\" is ignored on the root widget (the root has no parent slot)."), *NodeContext(Node)));
		}
		return nullptr;
	}

	// A node can target a named slot instead of the parent's default child list. Two flavours:
	//  - the parent itself is a UNamedSlot (we built it from a node);
	//  - the parent is a reused widget blueprint instance that exposes slots, which UUserWidget
	//    implements through INamedSlotInterface.
	if (!Node.NamedSlot.IsEmpty())
	{
		const FName SlotName(*Node.NamedSlot);

		if (UNamedSlot* Slot = Cast<UNamedSlot>(ParentWidget))
		{
			if (Slot->GetContent() && Slot->GetContent() != &Widget)
			{
				Error(FString::Printf(TEXT("%s: named slot '%s' already holds '%s'; only one child per slot is supported."),
					*NodeContext(Node), *Node.NamedSlot, *Slot->GetContent()->GetName()));
				return nullptr;
			}
			return Slot->SetContent(&Widget);
		}

		if (INamedSlotInterface* SlotHost = Cast<INamedSlotInterface>(ParentWidget))
		{
			TArray<FName> SlotNames;
			SlotHost->GetSlotNames(SlotNames);
			if (SlotNames.Contains(SlotName))
			{
				// Named slot content is stored on the owning widget, so there is no UPanelSlot to
				// apply layout properties to - the slot's own layout lives inside the reused widget.
				SlotHost->SetContentForSlot(SlotName, &Widget);
				if (Node.Slot.IsValid())
				{
					Warn(FString::Printf(TEXT("%s: \"slot\" layout properties are ignored because '%s' is placed into a named slot of '%s'."),
						*NodeContext(Node), *Node.NamedSlot, *ParentWidget->GetName()));
				}
				return nullptr;
			}

			Error(FString::Printf(TEXT("%s: namedSlot \"%s\" was requested but '%s' exposes no slot with that name (available: %s)."),
				*NodeContext(Node), *Node.NamedSlot, *ParentWidget->GetName(),
				*FString::JoinBy(SlotNames, TEXT(", "), [](const FName& InName) { return InName.ToString(); })));
			return nullptr;
		}

		Warn(FString::Printf(TEXT("%s: namedSlot \"%s\" was requested but '%s' (%s) is not a slot host; falling back to a normal child."),
			*NodeContext(Node), *Node.NamedSlot, *ParentWidget->GetName(), *ParentWidget->GetClass()->GetName()));
	}

	// Single-child containers must go through SetContent; panels through AddChild.
	if (UContentWidget* Content = Cast<UContentWidget>(ParentWidget))
	{
		if (Content->GetContent() && Content->GetContent() != &Widget)
		{
			Error(FString::Printf(TEXT("%s: '%s' is a single-child container and already has content ('%s'); only one child is supported."),
				*NodeContext(Node), *ParentWidget->GetName(), *Content->GetContent()->GetName()));
			return nullptr;
		}
		return Content->SetContent(&Widget);
	}

	if (UPanelWidget* Panel = Cast<UPanelWidget>(ParentWidget))
	{
		return Panel->AddChild(&Widget);
	}

	Error(FString::Printf(TEXT("%s: parent '%s' (%s) cannot host children; use a panel (VerticalBox, CanvasPanel, Overlay, ...) or a content widget (Border, SizeBox, Button, ...)."),
		*NodeContext(Node), *ParentWidget->GetName(), *ParentWidget->GetClass()->GetName()));
	return nullptr;
}

int32 FHtml2UMGWidgetBuilder::ApplyProperties(const FH2UNode& Node, UWidget& Widget)
{
	Widget.bIsVariable = Node.IsVariable() ? 1 : 0;

	if (!Node.Properties.IsValid())
	{
		return 0;
	}

	const FH2UObjectResolver Resolver = [this](const FString& Reference, UClass* ExpectedClass, const FString& InContext) -> UObject*
	{
		return Assets.Resolve(Reference, ExpectedClass, InContext);
	};

	const FString Context = FString::Printf(TEXT("%s properties"), *NodeContext(Node));
	const FH2UApplyStats Stats = FHtml2UMGPropertyApplier::ApplyJsonObject(&Widget, Node.Properties, Resolver, Sink, Context);

	PropertiesSet += Stats.Applied;
	UnknownProperties += Stats.UnknownKeys;
	FailedProperties += Stats.Failed;
	return Stats.Applied;
}

void FHtml2UMGWidgetBuilder::ApplySlot(const FH2UNode& Node, UPanelSlot* Slot)
{
	if (!Slot || !Node.Slot.IsValid())
	{
		return;
	}

	const FH2UObjectResolver Resolver = [this](const FString& Reference, UClass* ExpectedClass, const FString& InContext) -> UObject*
	{
		return Assets.Resolve(Reference, ExpectedClass, InContext);
	};

	const FString Context = FString::Printf(TEXT("%s slot (%s)"), *NodeContext(Node), *Slot->GetClass()->GetName());
	const FH2UApplyStats Stats = FHtml2UMGPropertyApplier::ApplyJsonObject(Slot, Node.Slot, Resolver, Sink, Context);

	PropertiesSet += Stats.Applied;
	UnknownProperties += Stats.UnknownKeys;
	FailedProperties += Stats.Failed;
}

int32 FHtml2UMGWidgetBuilder::ApplyBrushBlock(const FH2UNode& Node, UWidget& Widget)
{
	if (!Node.Brush.IsValid())
	{
		return 0;
	}

	// A node may carry both a `brush` block and an explicit `WidgetStyle` (a Button whose
	// Normal/Hovered/Pressed/Disabled were authored separately). The brush block describes a
	// single state, so letting it run would flatten the authored states back to Normal.
	if (Widget.IsA<UButton>() && Node.Properties.IsValid() && Node.Properties->HasField(TEXT("WidgetStyle")))
	{
		UE_LOG(LogHtml2UMG, Verbose,
			TEXT("Html2UMG: %s: skipping the single-state brush block because WidgetStyle already carries the button states."),
			*NodeContext(Node));
		return 0;
	}

	const FH2UObjectResolver Resolver = [this](const FString& Reference, UClass* ExpectedClass, const FString& InContext) -> UObject*
	{
		return Assets.Resolve(Reference, ExpectedClass, InContext);
	};

	FH2UBrushContext BrushContext;
	BrushContext.WidgetSize = EstimateWidgetSize(Node);

	const FString Context = FString::Printf(TEXT("%s brush"), *NodeContext(Node));
	const FH2UApplyStats Stats = FHtml2UMGPropertyApplier::ApplyBrush(&Widget, Node.Brush, BrushContext, Resolver, Sink, Context);

	PropertiesSet += Stats.Applied;
	UnknownProperties += Stats.UnknownKeys;
	FailedProperties += Stats.Failed;
	return Stats.Applied;
}

FVector2D FHtml2UMGWidgetBuilder::EstimateWidgetSize(const FH2UNode& Node) const
{
	// 1. An explicit SizeBox override is the most reliable statement of intent.
	if (Node.Properties.IsValid())
	{
		double Width = 0.0;
		double Height = 0.0;
		const bool bHasWidth = TryGetNumber(Node.Properties, TEXT("WidthOverride"), Width);
		const bool bHasHeight = TryGetNumber(Node.Properties, TEXT("HeightOverride"), Height);
		if (bHasWidth && bHasHeight && Width > 0.0 && Height > 0.0)
		{
			return FVector2D(Width, Height);
		}
	}

	// 2. Canvas slot offsets describe the box the widget will occupy.
	if (Node.Slot.IsValid())
	{
		const TSharedPtr<FJsonObject>* LayoutData = nullptr;
		if (Node.Slot->TryGetObjectField(TEXT("LayoutData"), LayoutData) && LayoutData && LayoutData->IsValid())
		{
			const TSharedPtr<FJsonObject>* Offsets = nullptr;
			if ((*LayoutData)->TryGetObjectField(TEXT("Offsets"), Offsets) && Offsets && Offsets->IsValid())
			{
				double Left = 0.0;
				double Top = 0.0;
				double Right = 0.0;
				double Bottom = 0.0;
				TryGetNumber(*Offsets, TEXT("Left"), Left);
				TryGetNumber(*Offsets, TEXT("Top"), Top);
				TryGetNumber(*Offsets, TEXT("Right"), Right);
				TryGetNumber(*Offsets, TEXT("Bottom"), Bottom);

				const double Width = Right - Left;
				const double Height = Bottom - Top;
				if (Width > 0.0 && Height > 0.0)
				{
					return FVector2D(Width, Height);
				}
			}
		}
	}

	// 3. The brush's own image size.
	if (Node.Brush.IsValid())
	{
		const FVector2D ImageSize = ReadSizeFromArray(Node.Brush->TryGetField(TEXT("imageSize")));
		if (ImageSize.X > 0.0 && ImageSize.Y > 0.0)
		{
			return ImageSize;
		}
	}

	// 4. Unknown: use the design viewport, which keeps clamping harmless (a full-screen widget).
	return DesignViewport;
}

UWidget* FHtml2UMGWidgetBuilder::BuildNode(const FH2UNode& Node, UWidget* ParentWidget, int32 Depth)
{
	if (Depth > kMaxTreeDepth)
	{
		Error(FString::Printf(TEXT("%s: widget tree deeper than %d, aborting this subtree."), *NodeContext(Node), kMaxTreeDepth));
		return nullptr;
	}

	FString ClassError;
	UClass* WidgetClass = ResolveWidgetClass(Node.ClassName, ClassError);
	if (!WidgetClass)
	{
		Error(FString::Printf(TEXT("%s: %s"), *NodeContext(Node), *ClassError));
		return nullptr;
	}

	const FName DesiredName(*Html2UMG::SanitizeWidgetName(Node.Name));
	UWidget* Widget = AcquireWidget(Node, WidgetClass, DesiredName);
	if (!Widget)
	{
		return nullptr;
	}

	const int32 AppliedProperties = ApplyProperties(Node, *Widget);

	if (UPanelSlot* Slot = AttachToParent(*Widget, ParentWidget, Node))
	{
		ApplySlot(Node, Slot);
	}

	const int32 AppliedBrush = ApplyBrushBlock(Node, *Widget);

	// Reflection writes land in the UPROPERTY, but many UMG widgets cache that state into their
	// constructed Slate widget (UTextBlock::SynchronizeProperties pushes Text/Font/Colour, style
	// structs rebuild the Slate style). Sync once per widget, only when something was actually
	// written, so we never re-sync widgets we did not touch.
	if (AppliedProperties + AppliedBrush > 0)
	{
		Widget->SynchronizeProperties();
	}

	for (const TSharedPtr<FH2UNode>& Child : Node.Children)
	{
		if (Child.IsValid())
		{
			BuildNode(*Child, Widget, Depth + 1);
		}
	}

	return Widget;
}

UWidget* FHtml2UMGWidgetBuilder::Build(const FH2UNode& RootNode, bool bReuseExisting)
{
	bRebuildInPlace = bReuseExisting;

	if (bRebuildInPlace)
	{
		PrepareInPlaceRebuild();
	}
	else
	{
		PrepareCleanRebuild();
	}

	UWidget* NewRoot = BuildNode(RootNode, nullptr, 0);

	if (bRebuildInPlace)
	{
		RetireUnusedWidgets();
	}

	Tree.RootWidget = NewRoot;
	return NewRoot;
}
